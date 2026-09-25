"""DB-80 — `email_owner_ready`, `post_meeting` version 6's own last step: the "your meeting is
ready" mail an AD HOC meeting's owner gets, because nothing before this step ever told them.

THE GAP THIS CLOSES. `email_minutes` already mails the ORGANISER — a name a calendar invite
supplied. meeting-api's ad hoc completion (`core/meetings/services/meeting-api/src/meeting_api/
events.py`'s `meeting_completed_refs`) carries `{uid, meeting_id, native, platform,
completion_reason}` and no organiser at all, so `email_minutes` skips it cleanly (see
`test_ad_hoc_post_meeting.py`) — and until this step existed, that was the end of it: `uid` is a
platform id, never an address, and no step resolved one from the other. This step owns exactly
that resolution and mails exactly that person, subject to the SAME `mail_minutes` setting
`email_minutes` already honours.

THE SIX PROPERTIES this file holds, matching the task's own list:
  1. an ad hoc meeting mails the owner exactly once, with an excerpt and a link;
  2. no link when `VEXA_FLOWS_DASHBOARD_URL` is unset;
  3. a `status: skipped` summary still earns the mail, with no excerpt (never ungrounded text);
  4. `mail_minutes` off sends nothing;
  5. a second call for the same meeting — the shape a step retry or a redelivery-that-somehow-
     reached-this-step would take — sends no second mail (`mail_outbox_sent`, the same table
     `_drive` already dedupes a conversation's outbox against);
  6. the invite path is an unchanged, clean no-op — `email_minutes` already addressed it.

The step is called DIRECTLY, exactly as `test_meeting_summary.py` and `test_ad_hoc_post_meeting.py`
already call `commit_meeting_summary` / `email_minutes` — no engine, no admission. `notify`'s
channel and `production.{setting,platform_user_email}` are replaced by fakes; `db` is a small
in-memory stand-in for `mail_outbox_sent` so the dedupe path is actually exercised rather than
trivially green the way `_StubDB.execute` (always `[]`) would leave it.
"""
from __future__ import annotations

import flows_steps.notify as notify_mod
import pytest
import flows_defs.production as production
from flows import Done, Reaction, Registry, StepCtx

from test_link_loop import FakeChannel

# THE EXACT AD HOC SHAPE — mirrored from `meeting_api.events.meeting_completed_refs`, the same
# literal `test_ad_hoc_post_meeting.py`'s `AD_HOC_REFS` pins.
AD_HOC_REFS = {"uid": "7", "meeting_id": "97", "native": "abc123", "platform": "google_meet",
               "completion_reason": "left"}
INVITE_REFS = {"uid": "7", "organizer": "anna@bank.test", "meeting_id": 97}

REPORT = ("We agreed the pilot ships on the 21st.\n\n"
          "## Decisions\n- ship it on the 21st\n\n"
          "## Action items\n- Ben — the migration doc\n\n"
          "## Open questions\n- who owns the rollback plan?")

# `commit_meeting_summary`'s own two shapes — this step reads its receipt, never re-derives it.
COMPLETE_PRIOR = {"process_meeting": {"report": REPORT},
                  "commit_meeting_summary": {"path": "meetings/97/summary.md",
                                              "status": "complete", "meeting_id": 97}}
SKIPPED_PRIOR = {"process_meeting": {"report": ""},
                 "commit_meeting_summary": {"path": "meetings/97/summary.md",
                                            "status": "skipped", "meeting_id": 97,
                                            "reason": "no transcript was captured"}}


class FakeOutboxDB:
    """A `mail_outbox_sent` table in memory — enough to exercise the actual check-then-insert
    dedupe, which `_StubDB.execute` (always `[]`, used elsewhere in this suite) would leave
    untested: every SELECT would read empty and every call would look like the first one."""

    def __init__(self):
        self.rows: set[tuple[str, str, str]] = set()

    def execute(self, sql, params=None):
        params = params or {}
        key = (str(params.get("u")), str(params.get("s")), str(params.get("h")))
        if sql.strip().startswith("SELECT"):
            return [(1,)] if key in self.rows else []
        if sql.strip().startswith("INSERT"):
            self.rows.add(key)
        return []


def _ctx(refs: dict, prior: dict, clock_now: float = 1_700_003_600.0) -> StepCtx:
    r = Reaction("rid", "sid", "e", refs, "f", 1, "step", "running", 1, 0.0, None, None, None)
    return StepCtx(reaction=r, effect_key="rid:step", prior=prior, clock_now=clock_now,
                   scratch={}, flow=None)


def _rig(monkeypatch, db, *, email: str = "owner@bank.test", mail_minutes: bool = True,
         dashboard_url: str | None = "https://dash.example.test"):
    reg = Registry()
    production.build(reg, db)
    monkeypatch.setattr(production, "setting",
                        lambda uid, key: mail_minutes if key == "mail_minutes"
                        else ("" if key == "timezone" else True))
    monkeypatch.setattr(production, "platform_user_email", lambda uid: email)
    if dashboard_url is None:
        monkeypatch.delenv("VEXA_FLOWS_DASHBOARD_URL", raising=False)
    else:
        monkeypatch.setenv("VEXA_FLOWS_DASHBOARD_URL", dashboard_url)
    channel = FakeChannel()
    notify_mod.use(channel)
    return reg, channel


# ── registration ──────────────────────────────────────────────────────────────────────────────
def test_email_owner_ready_is_the_new_last_step_of_post_meeting():
    reg = Registry()
    production.build(reg, FakeOutboxDB())
    steps = list(reg.flows[("post_meeting", 6)].steps)
    assert steps[-2:] == ["commit_meeting_summary", "email_owner_ready"]


def test_email_owner_ready_reaches_no_domain():
    """Unlike its neighbours, this step never calls `mt.*` or `ag.*` — only admin-api (identity,
    always present) and the notify port — so it declares no `needs=` at all."""
    reg = Registry()
    production.build(reg, FakeOutboxDB())
    assert "email_owner_ready" not in reg.step_needs
    assert reg.needs("email_owner_ready") == frozenset()


# ── 1 · exactly one mail, with the excerpt and the link ──────────────────────────────────────────
def test_ad_hoc_owner_gets_one_ready_mail_with_excerpt_and_link(monkeypatch):
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db)
    out = reg.steps["email_owner_ready"](_ctx(dict(AD_HOC_REFS), COMPLETE_PRIOR))

    assert isinstance(out, Done)
    assert out.result["message_id"]
    assert out.result["excerpt"] is True
    assert len(channel.sent) == 1
    sent = channel.sent[0]
    assert sent["to"] == "owner@bank.test"
    assert sent["link"] == "https://dash.example.test/meetings/97"
    assert "We agreed the pilot ships on the 21st." in sent["body"]


# ── 2 · no link when the dashboard URL is unset ──────────────────────────────────────────────────
def test_no_link_when_dashboard_url_is_unset(monkeypatch):
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db, dashboard_url=None)
    out = reg.steps["email_owner_ready"](_ctx(dict(AD_HOC_REFS), COMPLETE_PRIOR))

    assert isinstance(out, Done)
    assert out.result["link"] is None
    assert channel.sent[0]["link"] is None, "no guessed URL — VEXA_FLOWS_DASHBOARD_URL is unset"


# ── 3 · a skipped summary still sends "ready", with no excerpt ───────────────────────────────────
def test_skipped_summary_sends_ready_mail_with_no_excerpt(monkeypatch):
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db)
    out = reg.steps["email_owner_ready"](_ctx(dict(AD_HOC_REFS), SKIPPED_PRIOR))

    assert isinstance(out, Done)
    assert out.result["excerpt"] is False
    assert out.result["link"] == "https://dash.example.test/meetings/97"
    assert "## Overview" not in channel.sent[0]["body"], (
        "the grounding gate never cleared this report — the mail must not carry it")


# ── 4 · mail_minutes off sends nothing ────────────────────────────────────────────────────────────
def test_mail_minutes_off_sends_nothing(monkeypatch):
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db, mail_minutes=False)
    out = reg.steps["email_owner_ready"](_ctx(dict(AD_HOC_REFS), COMPLETE_PRIOR))

    assert out.result == {"skipped": "mail_minutes is off for this person"}
    assert channel.sent == []


# ── 5 · a second call for the same meeting sends no second mail ──────────────────────────────────
def test_a_second_call_for_the_same_meeting_sends_no_second_mail(monkeypatch):
    """The safety net UNDER admission-level dedup, not a replacement for it: `emit_completed`'s
    stable `done-{meeting_id}` source event id already stops a REDELIVERED `meeting.completed`
    from admitting a second `post_meeting` reaction at all (see
    `test_meeting_summary.py::test_redelivery_of_the_same_completion_admits_no_second_reaction`).
    This proves the step's OWN defence — the same `mail_outbox_sent` table `_drive` already
    dedupes a conversation's outbox against — for the case a step body re-runs within one
    reaction (a crash between the send and the `Done` that confirms it)."""
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db)
    first = reg.steps["email_owner_ready"](_ctx(dict(AD_HOC_REFS), COMPLETE_PRIOR))
    second = reg.steps["email_owner_ready"](_ctx(dict(AD_HOC_REFS), COMPLETE_PRIOR))

    assert first.result["message_id"]
    assert second.result == {"skipped": "already sent for this meeting"}
    assert len(channel.sent) == 1


# ── 6 · the invite path is an unchanged, clean no-op ──────────────────────────────────────────────
def test_invite_originated_meeting_is_a_clean_no_op(monkeypatch):
    """`email_minutes` already addressed this meeting's organiser — see
    `test_ad_hoc_post_meeting.py::test_the_invite_path_still_mails_and_drops_exactly_as_before`
    for the full-sequence proof that the recipient list is unchanged end to end."""
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db)
    out = reg.steps["email_owner_ready"](_ctx(dict(INVITE_REFS), COMPLETE_PRIOR))

    assert out.result == {"skipped": "invite-originated meeting — email_minutes already "
                                     "addressed the organiser"}
    assert channel.sent == []


# ── the owner-resolution edge: nobody to mail ─────────────────────────────────────────────────────
def test_no_email_on_file_skips_cleanly(monkeypatch):
    """A uid `platform_user_email` cannot resolve (the account was removed between admission and
    this read) is the same shape `email_minutes` already answers for "no organiser": a recorded
    skip, never a raise."""
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db, email="")
    out = reg.steps["email_owner_ready"](_ctx(dict(AD_HOC_REFS), COMPLETE_PRIOR))

    assert out.result == {"skipped": "no email on file for platform user 7"}
    assert channel.sent == []
