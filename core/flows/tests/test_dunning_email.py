"""DB-78 — `email_payment_failed`, the `dunning` flow's one step: the mail a subscriber gets when
a Stripe invoice fails, reacting to `payment.failed` (`core/identity/services/admin-api/src/
admin_api/app/events.py`'s `EVENT_PAYMENT_FAILED`).

THE FOUR PROPERTIES this file holds, matching DB-78's own list:
  1. exactly one mail, addressed to the failed invoice's subscriber, with a `/billing` link;
  2. no link when `VEXA_FLOWS_DASHBOARD_URL` is unset;
  3. a redelivered fact (or a step retry within one reaction) sends no second mail —
     `mail_outbox_sent`, keyed to the invoice, the same table `email_owner_ready` dedupes against;
  4. no email on file for the platform user is a clean skip, not an error.

Called DIRECTLY, exactly as `test_meeting_ready_email.py` calls `email_owner_ready` — no engine,
no admission. `notify`'s channel and `production.platform_user_email` are replaced by fakes;
`db` is the same in-memory `mail_outbox_sent` stand-in so the dedupe path is actually exercised.
"""
from __future__ import annotations

import flows_steps.notify as notify_mod
import pytest
import flows_defs.production as production
from flows import Done, Reaction, Registry, StepCtx, StepError

from test_link_loop import FakeChannel

REFS = {"subject": "42", "invoice_id": "in_test_1"}


class FakeOutboxDB:
    """A `mail_outbox_sent` table in memory — see `test_meeting_ready_email.py`'s own copy for
    why a real check-then-insert dedupe needs this rather than an always-empty stub."""

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


def _ctx(refs: dict, clock_now: float = 1_700_003_600.0) -> StepCtx:
    r = Reaction("rid-1", "src-1", "payment.failed", refs, "dunning", 1,
                "email_payment_failed", "running", 1, 0.0, None, None, None)
    return StepCtx(reaction=r, effect_key="rid-1:email_payment_failed", prior={},
                   clock_now=clock_now, scratch={}, flow=None)


def _rig(monkeypatch, db, *, email: str | None = "billed@bank.test",
        dashboard_url: str | None = "https://dash.example.test"):
    reg = Registry()
    production.build(reg, db)
    monkeypatch.setattr(production, "platform_user_email", lambda uid: email)
    if dashboard_url is None:
        monkeypatch.delenv("VEXA_FLOWS_DASHBOARD_URL", raising=False)
    else:
        monkeypatch.setenv("VEXA_FLOWS_DASHBOARD_URL", dashboard_url)
    channel = FakeChannel()
    notify_mod.use(channel)
    return reg, channel


# ── registration ──────────────────────────────────────────────────────────────────────────────
def test_dunning_flow_reacts_to_payment_failed():
    reg = Registry()
    production.build(reg, FakeOutboxDB())
    assert list(reg.flows[("dunning", 1)].steps) == ["email_payment_failed"]
    assert reg.flows[("dunning", 1)].on == production.PAYMENT_FAILED


def test_email_payment_failed_reaches_no_domain():
    reg = Registry()
    production.build(reg, FakeOutboxDB())
    assert "email_payment_failed" not in reg.step_needs
    assert reg.needs("email_payment_failed") == frozenset()


# ── 1 · exactly one mail, with the billing link ───────────────────────────────────────────────────
def test_one_payment_failed_mail_with_billing_link(monkeypatch):
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db)
    out = reg.steps["email_payment_failed"](_ctx(dict(REFS)))

    assert isinstance(out, Done)
    assert out.result["message_id"]
    assert len(channel.sent) == 1
    sent = channel.sent[0]
    assert sent["to"] == "billed@bank.test"
    assert sent["link"] == "https://dash.example.test/billing"
    assert "failed" in sent["body"].lower()
    # AGENTS.md: never invent a price or legal term outside billing/catalog.py.
    assert "$" not in sent["body"]


# ── 2 · no link when the dashboard URL is unset ───────────────────────────────────────────────────
def test_no_link_when_dashboard_url_is_unset(monkeypatch):
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db, dashboard_url=None)
    out = reg.steps["email_payment_failed"](_ctx(dict(REFS)))

    assert out.result["link"] is None
    assert channel.sent[0]["link"] is None


# ── 3 · a redelivery / retry sends no second mail ────────────────────────────────────────────────
def test_a_second_call_for_the_same_invoice_sends_no_second_mail(monkeypatch):
    """The safety net UNDER admission-level dedup: identity's `payment_failed_source_id` already
    keys admission to the invoice, so a redelivered `invoice.payment_failed` (same event id) or a
    Stripe retry of the SAME unpaid invoice (a fresh event id) admits no second `dunning` reaction
    at all. This proves the step's OWN defence for a step retry within one admitted reaction."""
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db)
    first = reg.steps["email_payment_failed"](_ctx(dict(REFS)))
    second = reg.steps["email_payment_failed"](_ctx(dict(REFS)))

    assert first.result["message_id"]
    assert second.result == {"skipped": "already sent for this invoice"}
    assert len(channel.sent) == 1


def test_a_different_invoice_for_the_same_subject_gets_its_own_mail(monkeypatch):
    """The dedupe key is the INVOICE, not the subject — a second failed payment (a new invoice,
    a later billing cycle) is a new fact and earns its own mail."""
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db)
    reg.steps["email_payment_failed"](_ctx(dict(REFS)))
    second_refs = {"subject": "42", "invoice_id": "in_test_2"}
    out = reg.steps["email_payment_failed"](_ctx(second_refs))

    assert out.result["message_id"]
    assert len(channel.sent) == 2


# ── 4 · no email on file is a clean skip ──────────────────────────────────────────────────────────
def test_no_email_on_file_skips_cleanly(monkeypatch):
    db = FakeOutboxDB()
    reg, channel = _rig(monkeypatch, db, email=None)
    out = reg.steps["email_payment_failed"](_ctx(dict(REFS)))

    assert out.result == {"skipped": "no email on file for platform user 42"}
    assert channel.sent == []


# ── the subject-resolution edge: nobody to mail ───────────────────────────────────────────────────
def test_missing_subject_raises_a_terminal_step_error(monkeypatch):
    db = FakeOutboxDB()
    reg, _channel = _rig(monkeypatch, db)
    with pytest.raises(StepError) as exc:
        reg.steps["email_payment_failed"](_ctx({"invoice_id": "in_test_3"}))
    assert exc.value.retryable is False
