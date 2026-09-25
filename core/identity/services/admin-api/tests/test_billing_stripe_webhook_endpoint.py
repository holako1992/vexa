"""DB-73 — `POST /billing/webhook`, end to end: signature-gated, writes the right `users.data`
fields per event type, is a no-op on redelivery, converges to Stripe's CURRENT state under
reordering, ignores an unrecognized price, and (`customer.subscription.deleted`) resolves to free
AT PERIOD END through `entitlements.resolve_plan` — not immediately, matching Stripe's own "paid
through period_end" shape.

Same testcontainers-PG harness as the other identity billing suites (skips without docker). The
Stripe API itself is an `httpx.MockTransport` keyed by subscription id — `main._stripe_client` is
monkeypatched exactly as in `test_billing_stripe_checkout_portal.py`, so `GET /v1/subscriptions/{id}`
always answers with whatever this test told it "Stripe's current state" is, independent of what the
webhook BODY claims (proving the re-read design actually re-reads).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app import main as main_module
from admin_api.app.billing.catalog import CATALOG_VERSION
from admin_api.app.billing.entitlements import resolve_plan
from admin_api.app.billing.stripe_gateway import StripeClient
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker

WEBHOOK_SECRET = "whsec_test_only_endpoint"  # TEST VALUE (AGENTS.md) — never a real Stripe secret
PRO_MONTHLY_PRICE = "price_test_pro_monthly"

STRIPE_ENV = {
    "STRIPE_SECRET_KEY": "sk_test_only_endpoint",
    "STRIPE_WEBHOOK_SECRET": WEBHOOK_SECRET,
    "STRIPE_CHECKOUT_SUCCESS_URL": "https://app.example.com/billing?checkout=success",
    "STRIPE_CHECKOUT_CANCEL_URL": "https://app.example.com/billing?checkout=cancelled",
    "STRIPE_PORTAL_RETURN_URL": "https://app.example.com/billing",
    "STRIPE_PRICE_PRO_MONTHLY": PRO_MONTHLY_PRICE,
}


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    monkeypatch.delenv("VEXA_FLOWS_API_URL", raising=False)
    for key, value in STRIPE_ENV.items():
        monkeypatch.setenv(key, value)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _create_user(client, email):
    return client.post("/admin/users", headers=_admin(), json={"email": email}).json()["id"]


def _get_user(client, user_id):
    return client.get(f"/admin/users/{user_id}", headers=_admin()).json()


def _sign(payload: bytes, secret: str, timestamp: int) -> str:
    signed_payload = f"{timestamp}.".encode() + payload
    v1 = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={v1}"


def _post_webhook(client, event: dict, *, secret: str = WEBHOOK_SECRET):
    payload = json.dumps(event).encode()
    header = _sign(payload, secret, int(time.time()))
    return client.post("/billing/webhook", content=payload,
                       headers={"Stripe-Signature": header, "Content-Type": "application/json"})


class _SubscriptionServer:
    """The mock Stripe account: a table of subscription id -> current object, served from
    `GET /v1/subscriptions/{id}` regardless of what any webhook BODY claims — this is what proves
    the handler re-reads rather than trusting the delivered event."""

    def __init__(self):
        self.subscriptions: dict[str, dict] = {}
        self.get_calls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/v1/subscriptions/"):
            sub_id = path.rsplit("/", 1)[-1]
            self.get_calls.append(sub_id)
            sub = self.subscriptions.get(sub_id)
            if sub is None:
                return httpx.Response(404, json={"error": {"message": "no such subscription"}})
            return httpx.Response(200, json=sub)
        return httpx.Response(404, json={"error": {"message": f"unhandled path {path}"}})


def _wire_stripe(monkeypatch, server: _SubscriptionServer):
    transport = httpx.MockTransport(server.handler)
    monkeypatch.setattr(
        main_module, "_stripe_client",
        lambda: StripeClient(secret_key="sk_test_only_endpoint", transport=transport),
    )


def _subscription(sub_id, customer_id, *, status="active", price=PRO_MONTHLY_PRICE,
                  period_start=1_700_000_000, period_end=1_702_592_000,
                  cancel_at_period_end=False, canceled_at=None):
    return {
        "id": sub_id, "customer": customer_id, "status": status,
        "cancel_at_period_end": cancel_at_period_end,
        "current_period_start": period_start, "current_period_end": period_end,
        "canceled_at": canceled_at,
        "items": {"data": [{"price": {"id": price}}]},
    }


def _event(event_type, obj, event_id="evt_test_1"):
    return {"id": event_id, "type": event_type, "data": {"object": obj}}


# ── signature gate at the wire ───────────────────────────────────────────────────────────────

def test_webhook_rejects_a_bad_signature(client):
    r = _post_webhook(client, _event("customer.subscription.updated",
                                     _subscription("sub_x", "cus_x")), secret="whsec_wrong")
    assert r.status_code == 400


def test_webhook_rejects_a_missing_signature_header(client):
    payload = json.dumps(_event("customer.subscription.updated",
                                _subscription("sub_x", "cus_x"))).encode()
    r = client.post("/billing/webhook", content=payload,
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400


def test_webhook_with_no_stripe_config_503s(client, monkeypatch):
    for key in STRIPE_ENV:
        monkeypatch.delenv(key, raising=False)
    r = _post_webhook(client, _event("customer.subscription.updated",
                                     _subscription("sub_x", "cus_x")))
    assert r.status_code == 503


# ── each event type writes the right fields ──────────────────────────────────────────────────

def test_checkout_session_completed_writes_the_subscription_state(client, monkeypatch):
    uid = _create_user(client, "checkout-webhook@vexa.ai")
    server = _SubscriptionServer()
    server.subscriptions["sub_new"] = _subscription("sub_new", "cus_new", status="active")
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, _event(
        "checkout.session.completed",
        {"customer": "cus_new", "subscription": "sub_new", "client_reference_id": str(uid)},
    ))
    assert r.status_code == 200, r.text
    assert r.json()["handled"] is True

    data = _get_user(client, uid)["data"]
    assert data["stripe_customer_id"] == "cus_new"
    assert data["stripe_subscription_id"] == "sub_new"
    assert data["subscription_status"] == "active"
    assert data["subscription_tier"] == "pro"


def test_subscription_updated_resolves_by_stored_customer_id(client, monkeypatch):
    """No `client_reference_id` on this event type — the user is found by the `stripe_customer_id`
    already stored on their row (set by an earlier checkout.session.completed, simulated here via
    admin PATCH)."""
    uid = _create_user(client, "sub-updated@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_existing"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_existing"] = _subscription("sub_existing", "cus_existing", status="past_due")
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, _event(
        "customer.subscription.updated", {"id": "sub_existing", "customer": "cus_existing"},
    ))
    assert r.status_code == 200
    assert _get_user(client, uid)["data"]["subscription_status"] == "past_due"


def test_invoice_payment_failed_re_reads_and_writes_past_due(client, monkeypatch):
    uid = _create_user(client, "invoice-failed@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_dunning"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_dunning"] = _subscription("sub_dunning", "cus_dunning", status="past_due")
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, _event(
        "invoice.payment_failed",
        {"id": "in_1", "customer": "cus_dunning", "subscription": "sub_dunning"},
    ))
    assert r.status_code == 200
    assert _get_user(client, uid)["data"]["subscription_status"] == "past_due"


def test_invoice_paid_re_reads_and_writes_active(client, monkeypatch):
    uid = _create_user(client, "invoice-paid@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_paid"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_paid"] = _subscription("sub_paid", "cus_paid", status="active")
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, _event(
        "invoice.paid", {"id": "in_2", "customer": "cus_paid", "subscription": "sub_paid"},
    ))
    assert r.status_code == 200
    assert _get_user(client, uid)["data"]["subscription_status"] == "active"


def test_an_unknown_price_is_ignored_and_leaves_users_data_unchanged(client, monkeypatch):
    uid = _create_user(client, "unknown-price@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_unknown"}})
    before = _get_user(client, uid)["data"]
    server = _SubscriptionServer()
    server.subscriptions["sub_unknown"] = _subscription(
        "sub_unknown", "cus_unknown", price="price_never_configured",
    )
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, _event(
        "customer.subscription.updated", {"id": "sub_unknown", "customer": "cus_unknown"},
    ))
    assert r.status_code == 200
    assert r.json()["handled"] is False
    assert _get_user(client, uid)["data"] == before


# ── idempotency: redelivery is a no-op, reordering converges on Stripe's current state ──────────

def test_redelivery_of_the_same_event_is_a_no_op(client, monkeypatch):
    uid = _create_user(client, "redelivery@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_redeliver"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_redeliver"] = _subscription("sub_redeliver", "cus_redeliver", status="active")
    _wire_stripe(monkeypatch, server)

    event = _event("customer.subscription.updated",
                   {"id": "sub_redeliver", "customer": "cus_redeliver"}, event_id="evt_redeliver")
    r1 = _post_webhook(client, event)
    assert r1.status_code == 200
    data_after_first = {k: v for k, v in _get_user(client, uid)["data"].items() if k != "updated_by_webhook"}

    r2 = _post_webhook(client, event)  # the SAME event, delivered again
    assert r2.status_code == 200
    data_after_second = {k: v for k, v in _get_user(client, uid)["data"].items() if k != "updated_by_webhook"}
    assert data_after_first == data_after_second, "a redelivered event must not change the resolved state"


def test_out_of_order_delivery_converges_on_stripes_current_state(client, monkeypatch):
    """The scenario the module docstring names: a now-stale `customer.subscription.updated` event
    (customer 'active') arrives AFTER `customer.subscription.deleted` (customer now 'canceled').
    Because the handler re-reads the CURRENT subscription from Stripe rather than trusting either
    event's own body, whichever is processed last still writes 'canceled' — the stale event cannot
    un-cancel it."""
    uid = _create_user(client, "reordering@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_reorder"}})
    server = _SubscriptionServer()
    # Stripe's account-side truth: the subscription is ALREADY canceled by the time either
    # delivery is processed (both events describe the past; the API is asked for now).
    server.subscriptions["sub_reorder"] = _subscription(
        "sub_reorder", "cus_reorder", status="canceled", canceled_at=1_701_500_000,
    )
    _wire_stripe(monkeypatch, server)

    deleted_event = _event("customer.subscription.deleted",
                           {"id": "sub_reorder", "customer": "cus_reorder"}, event_id="evt_deleted")
    stale_updated_event = _event("customer.subscription.updated",
                                 {"id": "sub_reorder", "customer": "cus_reorder"}, event_id="evt_stale_update")

    # Deleted first, then the STALE updated event arrives after it (Stripe gives no ordering guarantee).
    assert _post_webhook(client, deleted_event).status_code == 200
    assert _post_webhook(client, stale_updated_event).status_code == 200

    data = _get_user(client, uid)["data"]
    assert data["subscription_status"] == "canceled", (
        "the stale 'updated' event must not resurrect an already-canceled subscription — "
        "both events re-read the SAME current state from Stripe"
    )


# ── subscription.deleted resolves to free AT PERIOD END, via resolve_plan ──────────────────────

def test_subscription_deleted_resolves_to_free_only_after_period_end(client, monkeypatch):
    uid = _create_user(client, "deleted-grace@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_deleted"}})
    period_end = int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp())
    server = _SubscriptionServer()
    server.subscriptions["sub_deleted"] = _subscription(
        "sub_deleted", "cus_deleted", status="canceled",
        period_start=int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp()),
        period_end=period_end, canceled_at=int(datetime(2026, 9, 15, tzinfo=timezone.utc).timestamp()),
    )
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, _event(
        "customer.subscription.deleted", {"id": "sub_deleted", "customer": "cus_deleted"},
    ))
    assert r.status_code == 200
    data = _get_user(client, uid)["data"]

    still_paid = resolve_plan(data, datetime(2026, 9, 20, tzinfo=timezone.utc))
    assert still_paid.plan_id == "pro", "still paid through period_end — Stripe's own shape"
    assert still_paid.will_renew is False

    after_period_end = resolve_plan(data, datetime(2026, 10, 2, tzinfo=timezone.utc))
    assert after_period_end.plan_id == "free", "resolves to free once period_end has passed"


def test_webhook_response_names_catalog_version_consistently(client, monkeypatch):
    """Sanity anchor: whatever the webhook writes, `resolve_plan` reads back under the SAME
    catalog version this build ships — not a separate hardcoded string."""
    uid = _create_user(client, "catalog-version@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_cv"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_cv"] = _subscription("sub_cv", "cus_cv", status="active")
    _wire_stripe(monkeypatch, server)
    _post_webhook(client, _event("customer.subscription.updated",
                                 {"id": "sub_cv", "customer": "cus_cv"}))
    data = _get_user(client, uid)["data"]
    resolved = resolve_plan(data, datetime.now(timezone.utc))
    assert resolved.catalog_version == CATALOG_VERSION
