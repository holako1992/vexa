"""`billing.stripe_webhook`'s PURE core: `apply_subscription_patch` (a Stripe subscription
object -> the `PlatformBillingDataPatch`-shaped dict, or `None` for an unrecognized price) and the
event-shape helpers that resolve WHICH subscription/user an event concerns.

No docker, no DB, no network — the acceptance table for the pure function is a table of
`apply_subscription_patch(subscription) == expected` assertions, per the module's own docstring.
The wire-level behaviour (writing to `users.data`, idempotency across redelivery/reordering) is
covered with the testcontainers harness in `test_billing_stripe_webhook_endpoint.py`.
"""
from __future__ import annotations

from admin_api.app.billing.stripe_webhook import (
    apply_subscription_patch,
    pending_change,
    client_reference_id_for_event,
    customer_id_for_event,
    subscription_id_for_event,
)

PRO_MONTHLY_PRICE = "price_test_pro_monthly"
TEAM_MONTHLY_PRICE = "price_test_team_monthly"


def _subscription(**overrides):
    base = {
        "id": "sub_test_1",
        "customer": "cus_test_1",
        "status": "active",
        "cancel_at_period_end": False,
        "current_period_start": 1_700_000_000,
        "current_period_end": 1_702_592_000,
        "items": {"data": [{"price": {"id": PRO_MONTHLY_PRICE}}]},
    }
    base.update(overrides)
    return base


def test_an_active_subscription_on_a_known_price_resolves_to_its_plan(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    patch = apply_subscription_patch(_subscription())
    assert patch == {
        "stripe_subscription_id": "sub_test_1",
        "subscription_status": "active",
        "subscription_tier": "pro",
        "subscription_interval": "month",
        "subscription_cancel_at_period_end": False,
        "subscription_pending_plan": None,
        "subscription_pending_interval": None,
        "subscription_pending_at": None,
        "subscription_current_period_start": 1_700_000_000,
        "subscription_current_period_end": 1_702_592_000,
    }


def test_team_price_resolves_to_the_team_tier(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_TEAM_MONTHLY", TEAM_MONTHLY_PRICE)
    patch = apply_subscription_patch(
        _subscription(items={"data": [{"price": {"id": TEAM_MONTHLY_PRICE}}]})
    )
    assert patch["subscription_tier"] == "team"


def test_an_unknown_price_is_logged_and_ignored(monkeypatch, caplog):
    """Nothing in this deployment's env names `price_totally_unrecognized` — the patch must be
    `None` (write nothing), never a guess."""
    monkeypatch.delenv("STRIPE_PRICE_PRO_MONTHLY", raising=False)
    monkeypatch.delenv("STRIPE_PRICE_PRO_YEARLY", raising=False)
    monkeypatch.delenv("STRIPE_PRICE_TEAM_MONTHLY", raising=False)
    monkeypatch.delenv("STRIPE_PRICE_TEAM_YEARLY", raising=False)
    with caplog.at_level("WARNING"):
        patch = apply_subscription_patch(
            _subscription(items={"data": [{"price": {"id": "price_totally_unrecognized"}}]})
        )
    assert patch is None
    assert "unrecognized price" in caplog.text.lower() or "price_totally_unrecognized" in caplog.text


def test_a_canceled_subscription_still_carries_its_period_end(monkeypatch):
    """`customer.subscription.deleted` re-read from Stripe: status is `canceled`, but Stripe keeps
    the paid-through `current_period_end` on the object — `resolve_plan` (entitlements.py) is what
    turns THAT into 'still Pro until period_end, then Free', not this function's job to decide."""
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    patch = apply_subscription_patch(_subscription(status="canceled", canceled_at=1_701_000_000))
    assert patch["subscription_status"] == "canceled"
    assert patch["subscription_current_period_end"] == 1_702_592_000
    assert patch["subscription_cancellation_date"] == 1_701_000_000


def test_period_bounds_fall_back_to_the_subscription_item(monkeypatch):
    """Some Stripe API versions carry `current_period_start`/`_end` only on the subscription ITEM,
    not the top-level object — this must not silently drop the period."""
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    sub = _subscription()
    del sub["current_period_start"]
    del sub["current_period_end"]
    sub["items"]["data"][0]["current_period_start"] = 1_700_000_000
    sub["items"]["data"][0]["current_period_end"] = 1_702_592_000
    patch = apply_subscription_patch(sub)
    assert patch["subscription_current_period_start"] == 1_700_000_000
    assert patch["subscription_current_period_end"] == 1_702_592_000


def test_no_price_at_all_is_treated_as_unrecognized(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    assert apply_subscription_patch(_subscription(items={"data": []})) is None


# ── event-shape helpers ───────────────────────────────────────────────────────────────────────

def test_checkout_session_completed_names_its_subscription_and_client_reference():
    obj = {"subscription": "sub_abc", "customer": "cus_abc", "client_reference_id": "42"}
    assert subscription_id_for_event("checkout.session.completed", obj) == "sub_abc"
    assert client_reference_id_for_event("checkout.session.completed", obj) == "42"
    assert customer_id_for_event(obj) == "cus_abc"


def test_checkout_session_with_no_subscription_is_none():
    """A Checkout Session in a mode other than `subscription` (should not happen — This always
    requests mode=subscription — but the parser must not crash on it)."""
    assert subscription_id_for_event("checkout.session.completed", {"customer": "cus_abc"}) is None


def test_subscription_events_name_the_subscription_id_directly():
    obj = {"id": "sub_xyz", "customer": "cus_xyz"}
    for event_type in (
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    ):
        assert subscription_id_for_event(event_type, obj) == "sub_xyz"
    assert client_reference_id_for_event("customer.subscription.updated", obj) is None


def test_invoice_events_name_the_subscription_field():
    obj = {"id": "in_1", "customer": "cus_inv", "subscription": "sub_inv"}
    assert subscription_id_for_event("invoice.paid", obj) == "sub_inv"
    assert subscription_id_for_event("invoice.payment_failed", obj) == "sub_inv"


def test_an_invoice_with_no_subscription_is_none():
    """A one-off invoice, unrelated to any subscription — This has nothing to re-read."""
    assert subscription_id_for_event("invoice.paid", {"customer": "cus_x"}) is None


def test_an_unhandled_event_type_names_no_subscription():
    assert subscription_id_for_event("customer.updated", {"id": "cus_1"}) is None


# ── a scheduled switch (downgrade, or monthly<->yearly) is read from the subscription schedule ──

def _schedule(current_end, next_phase_price, next_start=None):
    return {
        "id": "sub_sched_1",
        "current_phase": {"start_date": 1_700_000_000, "end_date": current_end},
        "phases": [
            {"start_date": 1_700_000_000, "end_date": current_end, "items": [{"price": TEAM_MONTHLY_PRICE}]},
            {"start_date": next_start or current_end, "end_date": None, "items": [{"price": next_phase_price}]},
        ],
    }


def test_a_scheduled_next_phase_is_the_pending_change(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    monkeypatch.setenv("STRIPE_PRICE_TEAM_MONTHLY", TEAM_MONTHLY_PRICE)
    sub = _subscription(
        items={"data": [{"price": {"id": TEAM_MONTHLY_PRICE}}]},
        schedule=_schedule(1_702_592_000, PRO_MONTHLY_PRICE),
    )
    assert pending_change(sub) == ("pro", "month", 1_702_592_000)
    patch = apply_subscription_patch(sub)
    assert patch["subscription_tier"] == "team"
    assert (patch["subscription_pending_plan"], patch["subscription_pending_interval"],
            patch["subscription_pending_at"]) == ("pro", "month", 1_702_592_000)


def test_an_expanded_price_object_in_a_phase_resolves_too(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    sched = _schedule(1_702_592_000, PRO_MONTHLY_PRICE)
    sched["phases"][1]["items"] = [{"price": {"id": PRO_MONTHLY_PRICE}}]
    assert pending_change(_subscription(schedule=sched)) == ("pro", "month", 1_702_592_000)


def test_no_schedule_or_an_unexpanded_one_means_no_pending_change(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    assert pending_change(_subscription()) is None
    assert pending_change(_subscription(schedule="sub_sched_1")) is None
    assert apply_subscription_patch(_subscription())["subscription_pending_plan"] is None


def test_a_schedule_in_its_last_phase_has_no_pending_change(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    sched = _schedule(1_702_592_000, PRO_MONTHLY_PRICE)
    sched["current_phase"] = {"start_date": 1_702_592_000, "end_date": 1_705_184_000}
    assert pending_change(_subscription(schedule=sched)) is None


def test_a_pending_phase_on_an_unknown_price_is_not_reported(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTHLY", PRO_MONTHLY_PRICE)
    assert pending_change(_subscription(schedule=_schedule(1_702_592_000, "price_unknown"))) is None
