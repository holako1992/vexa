"""DB-60 — the Otter-style AI note: `commit_meeting_summary`, the LAST step of `post_meeting`.

It writes `meetings/<row_id>/summary.md` in the organiser's own workspace, at a path the dashboard
can resolve from the meeting's ROW ID ALONE (no title, no date — unlike `drop_to_attendees`'s
`kg/entities/meeting/<date>-<slug>.md`, which only a mail RECIPIENT can already resolve).

No new agent turn: it reads `process_meeting`'s already-grounded report out of the receipt. Six
properties this file exists to hold:

  1. THE PATH is a pure function of the row id, nothing else.
  2. GROUNDING is re-checked, not assumed — an ungrounded report is skipped, never written as if
     it were trustworthy.
  3. AN EMPTY / near-empty transcript is skipped WITH A REASON, never a silent empty file.
  4. AN UNREADABLE transcript is a retryable failure, never confused with an empty one.
  5. IDEMPOTENT: a second run over the same inputs writes nothing new (content-compare), and
     admission's own dedup (`source_event_id`) means a redelivered `meeting.completed` never even
     reaches a second reaction.
  6. `status: skipped` vs `status: complete` is the whole difference between "nothing to say" and
     a real note — both are written, so "not yet generated" (a 404 — nothing has run) stays
     distinguishable from "skipped" (the path exists, says why) purely by whether the path exists.

No network: `ag.workspace_write` / `ws_file` are replaced by a fake desk store, and
`production.mt.{meeting_row,transcript_segment_count,transcript_text}` are replaced by fakes that
record what they were asked. `mt.grounded_in` is left REAL — it is pure and it is the function
under test in the ungrounded case.
"""
from __future__ import annotations

import flows_defs.production as production
import pytest
from flows import Done, Reaction, Registry, StepCtx, StepError

REFS = {"uid": "7", "organizer": "anna@bank.test", "title": "Pilot sync", "meeting_id": 97,
        "native": "abc123", "start": 1_700_003_600.0,
        "participants": ["anna@bank.test", "ben@bank.test"]}
REPORT = ("## Decisions\n- ship it on the 21st\n\n"
          "## Action items\n- Ben — the migration doc\n\n"
          "## Open questions\n- who owns the rollback plan?\n\n"
          "We agreed the pilot ships on the 21st.")
TRANSCRIPT = "Anna: we agreed the pilot ships on the 21st.\nBen: I will own the migration doc."
PRIOR = {"process_meeting": {"report": REPORT, "group": "", "room_read": []}}


class _StubDB:
    def execute(self, *a, **k):
        return []


class Store:
    """One subject's desk, as a dict, plus a write ledger — the idempotence tests read the
    ledger, not just the content, for the same reason `test_attendee_drop.py`'s does: a step that
    rewrites identical bytes still produces a commit in somebody's history if it does not skip."""

    def __init__(self):
        self.files: dict[tuple[str, str], str] = {}
        self.writes: list[tuple[str, str]] = []

    def write(self, uid, path, content):
        self.writes.append((uid, path))
        self.files[(uid, path)] = content

    def read(self, uid, path, slug=None):
        if slug == "_global":
            return None
        return self.files.get((uid, path))

    def of(self, uid, path):
        return self.files.get((uid, path))


class FakeMeetings:
    """`production.mt`'s three doors this step knocks on, canned. `row_id` may legitimately
    differ from `refs["meeting_id"]` (R-B06/R-B19's own lesson: never trust the ref), so both are
    tracked separately."""

    def __init__(self, *, row_id=97, segments=12, transcript=TRANSCRIPT, unreadable=False,
                 unreadable_on_reground=False):
        self.row_id = row_id
        self.segments = segments
        self.transcript = transcript
        self.unreadable = unreadable
        self.unreadable_on_reground = unreadable_on_reground
        self.calls: list[str] = []

    def meeting_row(self, uid, meeting_id, native):
        self.calls.append("meeting_row")
        return {"id": self.row_id} if self.row_id is not None else None

    def transcript_segment_count(self, uid, meeting_id):
        self.calls.append("transcript_segment_count")
        if self.unreadable:
            return None
        return self.segments

    def transcript_text(self, uid, meeting_id):
        self.calls.append("transcript_text")
        if self.unreadable or self.unreadable_on_reground:
            return None
        return self.transcript


def _ctx(refs: dict, prior: dict | None = None, clock_now=1_700_003_600.0) -> StepCtx:
    r = Reaction("rid", "sid", "e", refs, "f", 1, "step", "running", 1, 0.0, None, None, None)
    return StepCtx(reaction=r, effect_key="rid:step", prior=prior or {}, clock_now=clock_now,
                  scratch={}, flow=None)


def _rig(monkeypatch, store, meetings):
    reg = Registry()
    production.build(reg, _StubDB())
    monkeypatch.setattr(production, "ws_file", store.read)
    monkeypatch.setattr(production.ag, "workspace_write", store.write)
    monkeypatch.setattr(production.mt, "meeting_row", meetings.meeting_row)
    monkeypatch.setattr(production.mt, "transcript_segment_count",
                        meetings.transcript_segment_count)
    monkeypatch.setattr(production.mt, "transcript_text", meetings.transcript_text)
    return reg


# ── 1 · the path is a pure function of the row id ────────────────────────────────────────────
def test_the_path_is_derived_from_the_row_id_alone(monkeypatch):
    store, meetings = Store(), FakeMeetings(row_id=4321)
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert out.result["path"] == "meetings/4321/summary.md"
    assert store.of("7", "meetings/4321/summary.md") is not None


def test_the_path_never_names_the_title_or_the_date(monkeypatch):
    """Unlike `_note_path`. A dashboard reading by row id alone must never need either."""
    store, meetings = Store(), FakeMeetings(row_id=97)
    reg = _rig(monkeypatch, store, meetings)
    reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    written = {p for _uid, p in store.writes}
    assert written == {"meetings/97/summary.md"}
    assert "pilot" not in list(written)[0].lower()


def test_the_row_id_is_used_not_the_ref_when_they_differ(monkeypatch):
    """R-B06/R-B19's own lesson, applied here: `refs["meeting_id"]` may be a native id or a stale
    ref; the RESOLVED row is what the path is keyed on."""
    store = Store()
    meetings = FakeMeetings(row_id=999)  # differs from REFS["meeting_id"] == 97
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert out.result["path"] == "meetings/999/summary.md"


def test_falls_back_to_the_ref_when_the_row_cannot_be_resolved(monkeypatch):
    store = Store()
    meetings = FakeMeetings(row_id=None)
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert out.result["path"] == "meetings/97/summary.md"   # refs["meeting_id"]


def test_no_row_id_and_no_ref_refuses_loudly(monkeypatch):
    store = Store()
    meetings = FakeMeetings(row_id=None)
    reg = _rig(monkeypatch, store, meetings)
    refs = dict(REFS)
    del refs["meeting_id"]
    with pytest.raises(StepError) as e:
        reg.steps["commit_meeting_summary"](_ctx(refs, PRIOR))
    assert "no row id" in str(e.value)
    assert e.value.retryable is False


# ── 2 · the shape (summary.v1) ────────────────────────────────────────────────────────────────
def test_a_complete_summary_carries_the_v1_frontmatter_and_all_four_sections(monkeypatch):
    store, meetings = Store(), FakeMeetings()
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))

    assert out.result["status"] == "complete"
    doc = store.of("7", "meetings/97/summary.md")
    assert doc.startswith("---\ntype: meeting-summary\nversion: v1\n")
    assert "meeting_id: 97" in doc
    assert "status: complete" in doc
    assert "generated_at: 2023-11-14T23:13:20Z" in doc   # ctx.clock_now, UTC, ISO 8601
    assert "## Overview" in doc and "## Decisions" in doc
    assert "## Action items" in doc and "## Open questions" in doc
    assert "ship it on the 21st" in doc
    assert "Ben — the migration doc" in doc
    assert "who owns the rollback plan?" in doc
    # the overview is what came before the first recognised heading, not the whole report again
    assert "We agreed the pilot ships on the 21st." in doc


def test_sections_the_report_never_named_are_explicit_not_omitted(monkeypatch):
    """A report with no `## Decisions` heading gets a Decisions section that SAYS none were
    recorded, rather than no heading at all — a reader (or the dashboard's parser) must not have
    to tell "we found nothing" apart from "we forgot to write this section"."""
    store, meetings = Store(), FakeMeetings()
    reg = _rig(monkeypatch, store, meetings)
    # Grounded (shares a real six-word run with TRANSCRIPT), but with no recognised headings.
    plain = "We agreed the pilot ships on the 21st, and that is the whole of it."
    prior = {"process_meeting": {"report": plain, "group": ""}}
    reg.steps["commit_meeting_summary"](_ctx(dict(REFS), prior))
    doc = store.of("7", "meetings/97/summary.md")
    assert "## Overview" in doc and plain in doc
    assert doc.count("_none recorded in this meeting._") == 3   # decisions, actions, questions


# ── 3 · skip empties ─────────────────────────────────────────────────────────────────────────
def test_no_transcript_is_skipped_with_a_reason_not_an_empty_file(monkeypatch):
    store = Store()
    meetings = FakeMeetings(segments=0)
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))

    assert out.result == {"path": "meetings/97/summary.md", "status": "skipped",
                          "reason": "no transcript was captured", "meeting_id": 97}
    doc = store.of("7", "meetings/97/summary.md")
    assert "status: skipped" in doc and "reason:" in doc
    assert "## Overview" not in doc                          # no body sections on a skip
    # `transcript_text` (the grounding re-check) is never reached once the floor already skips
    assert "transcript_text" not in meetings.calls


def test_too_few_segments_is_skipped_with_a_reason(monkeypatch):
    store = Store()
    meetings = FakeMeetings(segments=2)   # below the default floor of 3
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert out.result["status"] == "skipped"
    assert "2 segment" in out.result["reason"] and "3" in out.result["reason"]


def test_the_floor_is_a_flow_param(monkeypatch):
    store = Store()
    meetings = FakeMeetings(segments=2)
    reg = _rig(monkeypatch, store, meetings)

    class _Flow:
        def param(self, name, default=None):
            return {"summary_min_segments": 1}.get(name, default)

    r = Reaction("rid", "sid", "e", dict(REFS), "f", 1, "step", "running", 1, 0.0, None, None, None)
    ctx = StepCtx(reaction=r, effect_key="rid:step", prior=PRIOR, clock_now=1_700_003_600.0,
                 scratch={}, flow=_Flow())
    out = reg.steps["commit_meeting_summary"](ctx)
    assert out.result["status"] == "complete"   # 2 >= the lowered floor of 1


def test_no_report_at_all_is_skipped_with_a_reason(monkeypatch):
    store = Store()
    meetings = FakeMeetings(segments=12)
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](
        _ctx(dict(REFS), {"process_meeting": {"report": "", "group": ""}}))
    assert out.result["status"] == "skipped"
    assert "no report" in out.result["reason"]


def test_an_unreadable_transcript_is_a_retryable_failure_not_a_skip(monkeypatch):
    """THE THREE-WAY ANSWER `mt.transcript_segment_count` documents, respected here: `None` is a
    broken read (a gateway restart), never confused with a meeting that genuinely captured
    nothing — the two must not look the same (R-B19's own rule, applied one level up)."""
    store = Store()
    meetings = FakeMeetings(unreadable=True)
    reg = _rig(monkeypatch, store, meetings)
    with pytest.raises(StepError) as e:
        reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert "could not be read" in str(e.value)
    assert e.value.retryable is True
    assert store.writes == []


def test_an_unreadable_transcript_on_the_reground_check_is_also_retryable(monkeypatch):
    store = Store()
    meetings = FakeMeetings(unreadable_on_reground=True)
    reg = _rig(monkeypatch, store, meetings)
    with pytest.raises(StepError) as e:
        reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert "grounding re-check" in str(e.value)
    assert e.value.retryable is True


# ── 4 · grounding, re-checked ────────────────────────────────────────────────────────────────
def test_an_ungrounded_report_is_skipped_not_published(monkeypatch):
    store = Store()
    meetings = FakeMeetings(transcript="Nothing about the report was ever said in this room.")
    reg = _rig(monkeypatch, store, meetings)
    prior = {"process_meeting": {"report": "A completely unrelated fabricated paragraph "
                                           "about a topic nobody discussed here today at all.",
                                "group": ""}}
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), prior))
    assert out.result["status"] == "skipped"
    assert "did not ground" in out.result["reason"]
    doc = store.of("7", "meetings/97/summary.md")
    assert "## Overview" not in doc
    assert "fabricated" not in doc                            # never published as if grounded


def test_a_grounded_report_is_published(monkeypatch):
    store, meetings = Store(), FakeMeetings()
    reg = _rig(monkeypatch, store, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert out.result["status"] == "complete"


# ── 5 · idempotence ───────────────────────────────────────────────────────────────────────────
def test_a_second_identical_run_writes_nothing_new(monkeypatch):
    store, meetings = Store(), FakeMeetings()
    reg = _rig(monkeypatch, store, meetings)
    reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert len(store.writes) == 1
    store.writes.clear()

    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert store.writes == [], f"a re-run wrote again: {store.writes}"
    assert out.result["status"] == "complete"


def test_redelivery_of_the_same_completion_admits_no_second_reaction():
    """THE EVENT-LAYER HALF: `emit_completed` emits with source event id `done-{meeting_id}`, and
    `flows.admission.admit` is `INSERT ... ON CONFLICT (source_event_id) DO NOTHING` — so a
    redelivered `meeting.completed` for the same meeting never creates a second `post_meeting`
    reaction, and `commit_meeting_summary` never runs a second time for it. No step machinery
    needed to prove this: it is `admit()`'s own contract, exercised directly."""
    from flows import FakeClock, Registry as _Registry, admit

    reg = _Registry()
    production.build(reg, _StubDB())

    class _RecordingDB:
        def __init__(self):
            self.rows = []

        def execute(self, sql, params=None):
            if "INSERT INTO reaction" in sql:
                sid = params["sid"]
                if any(r["sid"] == sid for r in self.rows):
                    return []
                self.rows.append({"sid": sid})
                return [{"reaction_id": params["rid"]}]
            return []

    db = _RecordingDB()
    clock = FakeClock()
    refs = {"meeting_id": 97, "uid": "7", "organizer": "anna@bank.test"}
    first = admit(db, reg, clock, source_event_id="done-97",
                  event_type="meeting.completed", subject_refs=refs)
    second = admit(db, reg, clock, source_event_id="done-97",
                   event_type="meeting.completed", subject_refs=refs)
    assert first == 1, "the first delivery admits one post_meeting reaction"
    assert second == 0, "the redelivery must not admit a second one"
    assert len([r for r in db.rows if r["sid"].endswith("::post_meeting")]) == 1


# ── 6 · the step is registered in post_meeting, ahead of DB-80's own last step ──────────────────
def test_commit_meeting_summary_is_registered_in_post_meeting():
    """`commit_meeting_summary` was the LAST step through version 5; version 6 (DB-80) adds
    `email_owner_ready` after it — which reads this step's own receipt (see
    `test_meeting_ready_email.py`), so the order here still matters even though "last" no longer
    names this step."""
    reg = Registry()
    production.build(reg, _StubDB())
    steps = list(reg.flows[("post_meeting", 6)].steps)
    assert steps == ["process_meeting", "email_minutes", "email_attendees",
                     "drop_to_attendees", "commit_meeting_summary", "email_owner_ready"]


def test_commit_meeting_summary_needs_agent_and_meetings():
    reg = Registry()
    production.build(reg, _StubDB())
    assert reg.step_needs["commit_meeting_summary"] == frozenset({"agent", "meetings"})


def test_commit_meeting_summary_never_dispatches_an_agent_turn(monkeypatch):
    """No second LLM call — it reads `process_meeting`'s receipt, already grounded once."""
    store, meetings = Store(), FakeMeetings()
    reg = _rig(monkeypatch, store, meetings)

    def no_turns(*a, **k):
        raise AssertionError("commit_meeting_summary dispatched an agent turn")
    monkeypatch.setattr(production.ag, "dispatch_turn", no_turns)
    monkeypatch.setattr(production.ag, "collect_reply", no_turns)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(REFS), PRIOR))
    assert out.result["status"] == "complete"
