"""An unnamed meeting gets a title and tags — from the SAME reply that is its summary.

`process_meeting`'s one agent turn opens its reply with a front-matter block (`_LABELS_RULE`):
`title:` and `tags:`. `_readable` already drops a leading front-matter block for every reader of
the report, and `commit_meeting_summary`, once its note is `status: complete`, hands the block to
`_label_untitled`, which writes onto the meeting row through `POST /meetings/{id}/annotate`.

What this file holds:

  1. AN UNTITLED, UNTAGGED meeting gets both, in one annotate, as `{title, metadata: {tags}}`.
  2. A PERSON'S TITLE WINS — including one set after the step began: the row is re-read right
     before the write, never trusted from an earlier read.
  3. TAGS land in the dashboard's stored form (`normalizeTag` in
     `clients/dashboard/src/lib/annotations.ts`), only when the row has no `tags` key, and the
     annotate body names `tags` and no other metadata key.
  4. A SKIPPED summary names nothing.
  5. A labelling failure of any kind never fails, or changes, the summary.

No network: the same fake desk and fake meetings doors `test_meeting_summary.py` uses, plus the
two doors this behaviour adds (`meeting_detail`, `annotate_meeting`), recorded.
"""
from __future__ import annotations

import flows_defs.production as production
import pytest
from flows import Registry

from test_meeting_summary import FakeMeetings, Store, _ctx, _rig, _StubDB

AD_HOC = {"uid": "7", "meeting_id": "97", "native": "abc123", "platform": "google_meet",
          "completion_reason": "left"}
BODY = ("We agreed the pilot ships on the 21st.\n\n"
        "## Action items\n- Ben — the migration doc\n")
LABELLED = ("---\ntitle: Pilot launch date\ntags: [Pilot, \"Release  Planning\"]\n---\n" + BODY)


def _prior(report: str) -> dict:
    return {"process_meeting": {"report": report, "group": "", "room_read": []}}


class LabelMeetings(FakeMeetings):
    """`FakeMeetings` plus the row as `GET /meetings/{id}` returns it, and a ledger of annotate
    bodies. `data_on_reread`, when set, is what the row says by the time it is re-read — a person
    who renamed the meeting after the step began."""

    def __init__(self, *, data=None, data_on_reread=None, detail_none=False, annotate_status=200,
                 annotate_raises=None, **kw):
        super().__init__(**kw)
        self.data = data if data is not None else {}
        self.data_on_reread = data_on_reread
        self.detail_none = detail_none
        self.annotate_status = annotate_status
        self.annotate_raises = annotate_raises
        self.annotated: list = []

    def meeting_row(self, uid, meeting_id, native):
        self.calls.append("meeting_row")
        return {"id": self.row_id, "data": dict(self.data)}

    def meeting_detail(self, uid, row_id):
        self.calls.append("meeting_detail")
        if self.detail_none:
            return None
        data = self.data_on_reread if self.data_on_reread is not None else self.data
        return {"id": row_id, "data": dict(data)}

    def annotate_meeting(self, uid, row_id, body):
        self.calls.append("annotate_meeting")
        if self.annotate_raises:
            raise self.annotate_raises
        self.annotated.append((uid, row_id, body))
        return self.annotate_status, ({"id": row_id} if self.annotate_status < 300
                                      else {"detail": "boom"})


def _run(monkeypatch, meetings, report=LABELLED, refs=None):
    store = Store()
    reg = _rig(monkeypatch, store, meetings)
    monkeypatch.setattr(production.mt, "meeting_detail", meetings.meeting_detail)
    monkeypatch.setattr(production.mt, "annotate_meeting", meetings.annotate_meeting)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(refs or AD_HOC), _prior(report)))
    return out, store


# ── 1 · an unnamed meeting is named and tagged, in one write ─────────────────────────────────
def test_an_untitled_untagged_meeting_gets_a_generated_title_and_tags(monkeypatch):
    m = LabelMeetings()
    out, store = _run(monkeypatch, m)
    assert out.result["status"] == "complete"
    assert m.annotated == [("7", 97, {"title": "Pilot launch date",
                                      "metadata": {"tags": ["pilot", "release planning"]}})]
    assert out.result["annotation"] == {
        "title": {"written": "Pilot launch date", "source": "generated"},
        "tags": {"written": ["pilot", "release planning"]}}


def test_the_label_block_never_reaches_the_summary_note(monkeypatch):
    m = LabelMeetings()
    _out, store = _run(monkeypatch, m)
    doc = store.of("7", "meetings/97/summary.md")
    assert "Pilot launch date" not in doc
    assert "Release  Planning" not in doc and "tags:" not in doc
    assert "We agreed the pilot ships on the 21st." in doc


def test_the_annotate_is_addressed_by_the_resolved_row_id(monkeypatch):
    m = LabelMeetings(row_id=4321)
    _run(monkeypatch, m)
    assert [rid for _u, rid, _b in m.annotated] == [4321]


def test_an_invite_title_is_written_in_preference_to_a_generated_one(monkeypatch):
    """The invite's subject is a person's own words for this meeting; the generated title is the
    fallback for a meeting nobody named at all."""
    m = LabelMeetings()
    refs = {**AD_HOC, "title": "Pilot sync", "organizer": "anna@bank.test"}
    out, _store = _run(monkeypatch, m, refs=refs)
    assert m.annotated[0][2]["title"] == "Pilot sync"
    assert out.result["annotation"]["title"] == {"written": "Pilot sync", "source": "invite"}


# ── 2 · a person's title always wins ─────────────────────────────────────────────────────────
def test_an_existing_title_is_never_overwritten(monkeypatch):
    m = LabelMeetings(data={"title": "Acme renewal"})
    out, _store = _run(monkeypatch, m)
    assert len(m.annotated) == 1
    body = m.annotated[0][2]
    assert "title" not in body
    assert body == {"metadata": {"tags": ["pilot", "release planning"]}}
    assert out.result["annotation"]["title"].startswith("kept")


def test_a_title_set_after_the_step_began_is_kept(monkeypatch):
    """The step resolved the row (untitled) at its start; a person renamed the meeting before the
    labelling write. The decision is made on the RE-READ, so the person's title stands."""
    m = LabelMeetings(data={}, data_on_reread={"title": "Named by Anna"})
    out, _store = _run(monkeypatch, m)
    assert m.calls.index("meeting_row") < m.calls.index("meeting_detail")
    assert m.calls.index("meeting_detail") < m.calls.index("annotate_meeting")
    assert all("title" not in body for _u, _r, body in m.annotated)
    assert out.result["annotation"]["title"].startswith("kept")


def test_a_blank_title_on_the_row_counts_as_untitled(monkeypatch):
    m = LabelMeetings(data={"title": "   "})
    _run(monkeypatch, m)
    assert m.annotated[0][2]["title"] == "Pilot launch date"


def test_nothing_to_write_means_no_annotate_at_all(monkeypatch):
    m = LabelMeetings(data={"title": "Acme renewal", "metadata": {"tags": ["acme"]}})
    out, _store = _run(monkeypatch, m)
    assert "annotate_meeting" not in m.calls
    assert out.result["annotation"] == {"title": "kept: the meeting already has a title",
                                        "tags": "kept: the meeting already has tags"}


# ── 3 · tags: stored form, only when absent, nothing else touched ───────────────────────────
def test_tags_are_written_in_the_dashboards_stored_form(monkeypatch):
    report = ("---\ntitle: Q3 planning\ntags:\n  - \"  Acme   Renewal \"\n  - PRICING\n"
              "  - acme renewal\n  - " + "x" * 33 + "\n  - Ops\n  - extra\n---\n" + BODY)
    m = LabelMeetings()
    _run(monkeypatch, m, report=report)
    tags = m.annotated[0][2]["metadata"]["tags"]
    assert tags == ["acme renewal", "pricing", "ops"]          # deduped, over-long dropped, max 3
    assert all(production.stored_tag(t) == t for t in tags)    # already stored-form: idempotent


def test_existing_tags_are_left_alone_even_an_empty_list(monkeypatch):
    for existing in (["acme"], []):
        m = LabelMeetings(data={"metadata": {"tags": existing, "crm_id": "X-1"}})
        out, _store = _run(monkeypatch, m)
        assert all("metadata" not in body for _u, _r, body in m.annotated)
        assert out.result["annotation"]["tags"].startswith("kept")


def test_the_annotate_names_no_metadata_key_but_tags(monkeypatch):
    """The store merges metadata key by key, so naming only `tags` is what leaves an agent's or
    an integration's other keys exactly as they were."""
    m = LabelMeetings(data={"metadata": {"crm_id": "X-1", "speaker_labels": {"S1": "Anna"}}})
    _run(monkeypatch, m)
    assert m.annotated[0][2]["metadata"] == {"tags": ["pilot", "release planning"]}


def test_a_non_object_metadata_is_not_overwritten(monkeypatch):
    m = LabelMeetings(data={"metadata": "written by somebody else"})
    _run(monkeypatch, m)
    assert all("metadata" not in body for _u, _r, body in m.annotated)


@pytest.mark.parametrize("raw,stored", [
    ("Acme", "acme"),
    ("  Acme \t  Renewal  ", "acme renewal"),
    ("\u00a0Acme\u3000Renewal\ufeff", "acme renewal"),       # JavaScript's \s, not just ASCII
    ("x" * 32, "x" * 32),
    ("x" * 33, None),
    ("\U0001F600" * 16, "\U0001F600" * 16),                   # 32 UTF-16 code units
    ("\U0001F600" * 17, None),                                # 34 — over, as the dashboard counts
    ("bad\x01tag", None),
    ("   ", None),
    (7, None),
])
def test_stored_tag_mirrors_the_dashboards_normalize_tag(raw, stored):
    assert production.stored_tag(raw) == stored


# ── 4 · a skipped summary names nothing ──────────────────────────────────────────────────────
@pytest.mark.parametrize("kw", [{"segments": 0}, {"segments": 2},
                                {"transcript": "Nothing here was ever said in this room at all."}])
def test_a_skipped_summary_writes_no_title_and_no_tags(monkeypatch, kw):
    m = LabelMeetings(**kw)
    out, _store = _run(monkeypatch, m)
    assert out.result["status"] == "skipped"
    assert "annotation" not in out.result
    assert "meeting_detail" not in m.calls and "annotate_meeting" not in m.calls


# ── 5 · a labelling failure never touches the summary ───────────────────────────────────────
@pytest.mark.parametrize("kw,needle", [
    ({"annotate_status": 500}, "HTTP 500"),
    ({"annotate_status": 413}, "HTTP 413"),
    ({"annotate_raises": production.StepError("http POST ...: timed out")}, "timed out"),
    ({"detail_none": True}, "could not be re-read"),
])
def test_a_failed_label_write_still_commits_the_summary(monkeypatch, kw, needle):
    m = LabelMeetings(**kw)
    out, store = _run(monkeypatch, m)
    assert out.result["status"] == "complete"
    assert "status: complete" in store.of("7", "meetings/97/summary.md")
    assert needle in out.result["annotation"]["error"]


def test_a_crash_while_reading_the_labels_still_commits_the_summary(monkeypatch):
    m = LabelMeetings()

    def boom(_report):
        raise ValueError("unparseable")
    monkeypatch.setattr(production, "_report_labels", boom)
    out, store = _run(monkeypatch, m)
    assert out.result["status"] == "complete"
    assert store.of("7", "meetings/97/summary.md") is not None
    assert "unparseable" in out.result["annotation"]["error"]


def test_a_report_with_no_label_block_writes_nothing_and_says_so(monkeypatch):
    m = LabelMeetings()
    out, _store = _run(monkeypatch, m, report=BODY)
    assert out.result["status"] == "complete"
    assert "meeting_detail" not in m.calls and "annotate_meeting" not in m.calls
    assert out.result["annotation"] == {"title": "none generated", "tags": "none generated"}


# ── the label block: what the turn is asked for, and how it is read ─────────────────────────
def test_the_post_meeting_turn_is_asked_for_the_label_block():
    reg = Registry()
    production.build(reg, _StubDB())
    assert production._LABELS_RULE.strip().startswith("OPEN YOUR REPLY WITH A FRONT-MATTER BLOCK")
    import inspect
    src = inspect.getsource(production)
    rules = src[src.index("def _shared_report_rules("):src.index("def email_minutes(")]
    assert "_LABELS_RULE" in rules


@pytest.mark.parametrize("report,title,tags", [
    (LABELLED, "Pilot launch date", ["pilot", "release planning"]),
    ("---\ntitle: \"Acme: renewal pricing\"\ntags: acme, pricing\n---\nbody",
     "Acme: renewal pricing", ["acme", "pricing"]),
    ("---\ntitle: **Meeting notes**\ntags: []\n---\nbody", None, []),
    ("---\ntitle: '# Roadmap review'\n---\nbody", "Roadmap review", []),
    ("No front matter at all.\ntitle: not a label\n", None, []),
    ("---\ntitle: unterminated block\n", None, []),
])
def test_report_labels(report, title, tags):
    assert production._report_labels(report) == (title, tags)


def test_a_long_generated_title_is_cut_at_a_word_boundary():
    words = "Quarterly roadmap alignment across platform payments and growth teams " * 3
    t = production._plain_title(words)
    assert len(t) <= production.GENERATED_TITLE_MAX
    assert words.startswith(t) and not t.endswith(" ")
    assert words[len(t)] == " "                              # cut between words, not inside one

