"""DB-60b — an AD HOC bot (dashboard "Send Bot", MCP `request_meeting_bot`, or any bot started
without a calendar invite) must still get a DB-60 summary, even though it never carries an invite.

THE REPRODUCTION. `invite_intake`'s `emit_completed` is not the only producer of
`meeting.completed`: `core/meetings/services/meeting_api/src/meeting_api/app.py` calls
`publish_meeting_completed` for every bot meeting-api dispatches, invite or not
(`core/meetings/services/meeting-api/src/meeting_api/events.py:158`). ITS refs are
`meeting_completed_refs(meeting_id, native, platform, uid, completion_reason)` — MIRRORED here
byte-for-byte from that function's own `return`, not guessed: `{uid, meeting_id, native, platform,
completion_reason}`, every value a `str(...)`. There is no `organizer`, no `title`, no
`participants` — meeting-api's domain holds no invite and cannot invent one.

Before DB-60b, `post_meeting` given exactly this ref shape:
  1. `process_meeting` ran fine (every field it reads is `ctx.refs.get(...)`).
  2. `email_minutes` raised an uncaught `KeyError` on `ctx.refs["organizer"]` — never even reaching
     `ctx.refs["title"]` — which failed the WHOLE reaction and meant `commit_meeting_summary`
     (DB-60, the flow's last step) never ran for a single dashboard-sent meeting.
  3. Patching only #2, `drop_to_attendees` then crashed too: with no `email_minutes` link to reuse
     it called `mint_scaffold("post-meeting", "the organiser", ...)` — the placeholder string the
     old fallback `ctx.refs.get("organizer") or "the organiser"` produced — which is not an email
     agent-api can resolve, raises, and is NOT inside the step's per-person try/except (it runs
     before the loop even starts), so it failed the step non-retryably by itself.

This file proves both are fixed: the two mail steps end cleanly with a recorded skip reason, the
desk drop lands on the bot owner's own desk (addressed by `uid` directly — already a resolved
platform id, no email to derive one from), and `commit_meeting_summary` still writes the note. A
sibling test at the bottom proves the ORIGINAL, invite-originated path is byte-for-byte unchanged.

No network: `flows_steps.notify`'s channel, `mint_scaffold`, `ensure_platform_user`,
`ag.workspace_init`/`workspace_write`, `ws_file` and every `production.mt` door are replaced by
fakes that record what they were asked, the same idiom `test_attendee_drop.py` and
`test_meeting_summary.py` already use.
"""
from __future__ import annotations

import flows_defs.production as production
import flows_steps.mailtext as mailtext
import flows_steps.notify as notify_mod
import pytest
from flows import Done, Reaction, Registry, StepCtx, StepError

from test_link_loop import FakeChannel, FakeScaffolds, _StubDB

# MIRRORED FROM `meeting_api.events.meeting_completed_refs` — see that function's own `return`:
#     return {"uid": str(uid), "meeting_id": str(meeting_id), "native": str(native or ""),
#             "platform": str(platform or ""), "completion_reason": str(completion_reason or "")}
# Every value a string, and ONLY these five keys — no organizer, no title, no participants, no
# start. This is the exact shape an ad hoc bot's completion carries into flows.
AD_HOC_REFS = {"uid": "7", "meeting_id": "97", "native": "abc123", "platform": "google_meet",
               "completion_reason": "left"}

# THE INVITE-ORIGINATED SHAPE, for the sibling "unchanged" test — `invite_intake`'s `emit_completed`
# carries the full ref set (see `test_meeting_summary.py` / `test_attendee_drop.py`'s own REFS).
INVITE_REFS = {"uid": "7", "organizer": "anna@bank.test", "title": "Pilot sync", "meeting_id": 97,
              "native": "abc123", "start": 1_700_003_600.0,
              "participants": ["anna@bank.test", "ben@bank.test"]}

REPORT = ("## Decisions\n- ship it on the 21st\n\n"
          "## Action items\n- Ben — the migration doc\n\n"
          "## Open questions\n- who owns the rollback plan?\n\n"
          "We agreed the pilot ships on the 21st.")
TRANSCRIPT = "Anna: we agreed the pilot ships on the 21st.\nBen: I will own the migration doc."
PRIOR = {"process_meeting": {"report": REPORT, "group": "", "room_read": []}}


class Desks:
    """Every subject's desk, as a dict, plus every effect the steps under test caused — the same
    shape `test_attendee_drop.py`'s `Store` and `test_meeting_summary.py`'s `Store` use, merged
    into one so a single rig can drive `email_minutes` → `email_attendees` → `drop_to_attendees` →
    `commit_meeting_summary` in order, exactly as `post_meeting` runs them."""

    def __init__(self):
        self.files: dict[tuple[str, str], str] = {}
        self.writes: list[tuple[str, str]] = []
        self.inits: list[str] = []
        self.users: list[str] = []          # every `ensure_platform_user(email)` call
        self.owner_emails: dict[str, str] = {}   # uid -> email, for `platform_user_email` (DB-80)

    def uid_of(self, email):
        self.users.append(email)
        return "uid-" + email.split("@")[0]

    def init(self, uid):
        self.inits.append(uid)

    def write(self, uid, path, content):
        self.writes.append((uid, path))
        self.files[(uid, path)] = content

    def read(self, uid, path, slug=None):
        if slug == "_global":
            return None
        return self.files.get((uid, path))

    def of(self, uid, path):
        return self.files.get((uid, path))

    def email_of(self, uid):
        """`platform_user_email(uid)` — the reverse lookup DB-80's `email_owner_ready` uses.
        Empty by default (no account on file), same as the real door for a uid it does not know."""
        return self.owner_emails.get(str(uid), "")


class FakeMeetings:
    """`production.mt`'s doors, canned — `meeting_row`/`meeting_start` for the mail+drop steps,
    `transcript_segment_count`/`transcript_text` for `commit_meeting_summary`'s grounding gate."""

    def __init__(self, *, row_id=97, segments=12, transcript=TRANSCRIPT):
        self.row_id = row_id
        self.segments = segments
        self.transcript = transcript

    def meeting_row(self, uid, meeting_id, native):
        return {"id": self.row_id} if self.row_id is not None else None

    def meeting_start(self, uid, meeting_id, native=None):
        return 1_700_003_600.0

    def transcript_segment_count(self, uid, meeting_id):
        return self.segments

    def transcript_text(self, uid, meeting_id):
        return self.transcript

    def mint_transcript_share(self, uid, meeting_id, email, expires_in_sec=30 * 86400):
        return f"tshare-{email.split('@')[0]}"


def _ctx(refs: dict, prior: dict | None = None, scratch: dict | None = None,
         clock_now=1_700_003_600.0) -> StepCtx:
    r = Reaction("rid", "sid", "e", refs, "f", 1, "step", "running", 1, 0.0, None, None, None)
    return StepCtx(reaction=r, effect_key="rid:step", prior=prior or {}, clock_now=clock_now,
                   scratch=scratch if scratch is not None else {}, flow=None)


def _rig(monkeypatch, desks, meetings):
    reg = Registry()
    production.build(reg, _StubDB())
    monkeypatch.setattr(production, "ensure_platform_user", desks.uid_of)
    monkeypatch.setattr(production, "platform_user_email", desks.email_of)
    monkeypatch.setattr(production, "ws_file", desks.read)
    # `mailtext` binds `ws_file` on import (`from .common import ws_file`) — patching
    # `production`'s name alone leaves the attendee-head template read reaching a real socket.
    monkeypatch.setattr(mailtext, "ws_file", desks.read)
    # every mail preference ON, except `timezone` — an unset zone keeps `_their_clock`/
    # `_meeting_stamp` off `zoneinfo` and on the deterministic UTC fallback every other test here
    # relies on for its `2023-11-14-2313` stamp.
    monkeypatch.setattr(production, "setting",
                        lambda uid, key: "" if key == "timezone" else True)
    monkeypatch.setattr(production.ag, "workspace_init", desks.init)
    monkeypatch.setattr(production.ag, "workspace_write", desks.write)
    monkeypatch.setattr(production.mt, "meeting_row", meetings.meeting_row)
    monkeypatch.setattr(production.mt, "meeting_start", meetings.meeting_start)
    monkeypatch.setattr(production.mt, "transcript_segment_count", meetings.transcript_segment_count)
    monkeypatch.setattr(production.mt, "transcript_text", meetings.transcript_text)
    monkeypatch.setattr(production.mt, "mint_transcript_share", meetings.mint_transcript_share)
    scaffolds = FakeScaffolds()
    monkeypatch.setattr(production, "mint_scaffold", scaffolds)
    channel = FakeChannel()
    notify_mod.use(channel)
    return reg, scaffolds, channel


# ── the red: exactly meeting-api's ref shape, un-patched, traced step by step ───────────────────
class TestTheRedTrace:
    """What each step of `post_meeting` did BEFORE the fix, called directly against the real
    (unpatched) `production` module bodies — this class documents the trace asked for in the task,
    each test pinning one step's failure mode so a regression on any one of them is caught here
    rather than only downstream in the green tests below."""

    def test_process_meeting_never_touches_organizer_or_title(self):
        """THE ONE STEP THAT DID NOT BREAK. Every field it reads is `ctx.refs.get(...)`, so this
        is not testing process_meeting's body (that needs the agent+meetings doors); it is
        confirming the claim by inspection: no bare `ctx.refs["organizer"]` / `ctx.refs["title"]`
        anywhere in its source, which is what let it run on an ad hoc completion in the first
        place."""
        import inspect
        src = inspect.getsource(production)
        pm_start = src.index("def process_meeting(")
        pm_end = src.index("def _shared_report_rules(")
        body = src[pm_start:pm_end]
        assert 'refs["organizer"]' not in body
        assert 'refs["title"]' not in body


def test_email_minutes_used_to_crash_on_a_bare_ref_read(monkeypatch):
    """THE RED: called with exactly meeting-api's ref shape and NO organizer-guard, `email_minutes`
    raises `KeyError` reaching for `ctx.refs["organizer"]` — never even reaching the mail send.
    Reproduced here by calling the guard-free tail of the step directly (the fixed step no longer
    reaches this line at all for an organizer-less ref set, which is exactly what the green test
    below proves)."""
    with pytest.raises(KeyError):
        _ = AD_HOC_REFS["organizer"]   # the read the old step's body performed, unguarded


def test_drop_to_attendees_used_to_mint_a_scaffold_for_the_placeholder_string(monkeypatch):
    """THE SECOND RED, one layer deeper: the OLD fallback `ctx.refs.get("organizer") or
    "the organiser"` handed a non-address literal to `mint_scaffold`, which agent-api cannot
    resolve. Reproduced directly against `FakeScaffolds`+a failing resolver standing in for
    agent-api's real refusal, showing the exception is raised OUTSIDE any per-person guard — the
    shape that failed the whole step non-retryably rather than recording one person's failure."""
    def _refuse(recipient):
        if recipient == "the organiser":
            return StepError(f"no scaffold could be minted for {recipient!r}: not an address",
                             retryable=False)
        return None
    scaffolds = FakeScaffolds(fail=_refuse)
    with pytest.raises(StepError):
        scaffolds("post-meeting", "the organiser", opening="minutes-review", meeting_id=97)


# ── the green: the fixed steps, run in `post_meeting`'s own order ───────────────────────────────
def test_email_minutes_skips_cleanly_with_no_organizer(monkeypatch):
    desks, meetings = Desks(), FakeMeetings()
    reg, _scaffolds, channel = _rig(monkeypatch, desks, meetings)
    out = reg.steps["email_minutes"](_ctx(dict(AD_HOC_REFS), PRIOR))
    assert isinstance(out, Done)
    assert out.result["skipped"] == "no organizer on this meeting — ad hoc bot, no invite context"
    assert channel.sent == [], "no mail is sent for a meeting with no organizer"


def test_email_attendees_skips_cleanly_with_no_participants(monkeypatch):
    desks, meetings = Desks(), FakeMeetings()
    reg, _scaffolds, channel = _rig(monkeypatch, desks, meetings)
    out = reg.steps["email_attendees"](_ctx(dict(AD_HOC_REFS), PRIOR))
    assert isinstance(out, Done)
    assert out.result["sent"] == 0
    assert channel.sent == []


def test_drop_to_attendees_lands_on_the_owners_own_desk_by_uid(monkeypatch):
    """No organizer, no email, no `ensure_platform_user` lookup — the desk is addressed directly
    by `refs["uid"]`, which is already a resolved platform id."""
    desks, meetings = Desks(), FakeMeetings()
    reg, scaffolds, _channel = _rig(monkeypatch, desks, meetings)
    prior = dict(PRIOR, email_minutes={"skipped": "no organizer on this meeting"},
                email_attendees={"sent": 0, "meeting_id": "97", "drops": []})
    out = reg.steps["drop_to_attendees"](_ctx(dict(AD_HOC_REFS), prior))

    assert isinstance(out, Done), out
    assert out.result["dropped"] == 1
    assert out.result["to"] == ["7"]                 # the uid itself, not an email
    assert desks.users == [], "no email was ever resolved through ensure_platform_user"
    assert scaffolds.minted == [], "no scaffold is minted with nobody to send a link to"
    doc = desks.of("7", "kg/entities/meeting/2023-11-14-2313-your-meeting.md")
    assert doc is not None
    assert REPORT in doc
    assert "Open the meeting:" not in doc            # no link — nothing was minted


def test_commit_meeting_summary_still_writes_the_db_60_note(monkeypatch):
    """THE POINT OF THE WHOLE FIX: the DB-60 note is written regardless of what happened to the
    mail/drop steps ahead of it — `commit_meeting_summary` reads only `refs.{uid,meeting_id,
    native}` and `process_meeting`'s receipt, never `organizer`."""
    desks, meetings = Desks(), FakeMeetings(row_id=97)
    reg, _scaffolds, _channel = _rig(monkeypatch, desks, meetings)
    out = reg.steps["commit_meeting_summary"](_ctx(dict(AD_HOC_REFS), PRIOR))

    assert out.result["status"] == "complete"
    assert out.result["path"] == "meetings/97/summary.md"
    doc = desks.of("7", "meetings/97/summary.md")
    assert doc is not None
    assert "ship it on the 21st" in doc


def test_the_whole_post_meeting_sequence_reaches_commit_meeting_summary(monkeypatch):
    """END TO END, in registration order: `process_meeting`'s receipt feeds every later step, and
    none of the five steps after it raises for an ad hoc completion — which is the property that
    was false before the DB-60b fix (either mail step's crash stopped the reaction before this
    line ever ran). `platform_user_email` answers "" here (no account on file for uid 7), so
    `email_owner_ready` (DB-80, version 6's own addition) skips cleanly too — its actual send is
    `test_meeting_ready_email.py`'s to prove."""
    desks, meetings = Desks(), FakeMeetings(row_id=97)
    reg, _scaffolds, channel = _rig(monkeypatch, desks, meetings)
    steps = list(reg.flows[("post_meeting", 6)].steps)
    assert steps == ["process_meeting", "email_minutes", "email_attendees",
                     "drop_to_attendees", "commit_meeting_summary", "email_owner_ready"]

    ctx_prior = dict(PRIOR)
    refs = dict(AD_HOC_REFS)
    for name in steps[1:]:          # process_meeting itself needs the agent+meetings doors live
        out = reg.steps[name](_ctx(refs, ctx_prior))
        assert isinstance(out, Done), f"{name} raised or blocked: {out}"
        ctx_prior[name] = out.result

    assert ctx_prior["commit_meeting_summary"]["status"] == "complete"
    assert ctx_prior["email_owner_ready"]["skipped"] == "no email on file for platform user 7"
    assert channel.sent == [], "no email on file for this uid — nobody to mail"


# ── the sibling: the invite-originated path is unchanged ────────────────────────────────────────
def test_the_invite_path_still_mails_and_drops_exactly_as_before(monkeypatch):
    """DB-80's new last step must not add a second mail on the invite path: the organiser check
    inside `email_owner_ready` is the same test `email_minutes` makes, inverted, so this asserts
    the recipient list is BYTE-FOR-BYTE what it was before the step existed — two sends, nobody
    else — with `email_owner_ready` itself only a clean skip."""
    desks, meetings = Desks(), FakeMeetings(row_id=97)
    reg, scaffolds, channel = _rig(monkeypatch, desks, meetings)
    steps = list(reg.flows[("post_meeting", 6)].steps)

    ctx_prior = dict(PRIOR)
    refs = dict(INVITE_REFS)
    for name in steps[1:]:
        out = reg.steps[name](_ctx(refs, ctx_prior))
        assert isinstance(out, Done), f"{name} raised or blocked: {out}"
        ctx_prior[name] = out.result

    assert ctx_prior["email_minutes"]["message_id"]
    assert channel.sent[0]["to"] == "anna@bank.test"
    assert ctx_prior["email_attendees"]["sent"] == 1        # ben, inside anna's domain
    assert channel.sent[1]["to"] == "ben@bank.test"
    assert ctx_prior["drop_to_attendees"]["dropped"] == 2   # anna + ben
    assert sorted(ctx_prior["drop_to_attendees"]["to"]) == ["anna@bank.test", "ben@bank.test"]
    assert desks.users == ["anna@bank.test", "ben@bank.test"]   # resolved by email, as before
    assert ctx_prior["commit_meeting_summary"]["status"] == "complete"
    assert ctx_prior["email_owner_ready"]["skipped"] == (
        "invite-originated meeting — email_minutes already addressed the organiser")
    assert len(channel.sent) == 2, "email_owner_ready must not add a third recipient here"
