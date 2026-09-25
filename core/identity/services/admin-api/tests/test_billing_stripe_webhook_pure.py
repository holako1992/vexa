"""DB-73 — `billing.stripe_webhook`'s PURE core: `apply_subscription_patch` (a Stripe subscription
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
        "subscription_cancel_at_period_end": False,
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
    """A Checkout Session in a mode other than `subscription` (should not happen — DB-73 always
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
    """A one-off invoice, unrelated to any subscription — DB-73 has nothing to re-read."""
    assert subscription_id_for_event("invoice.paid", {"customer": "cus_x"}) is None


def test_an_unhandled_event_type_names_no_subscription():
    assert subscription_id_for_event("customer.updated", {"id": "cus_1"}) is None
