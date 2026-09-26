"""DB-78 — `POST /billing/webhook`'s `invoice.payment_failed` handling publishes ONE
`payment.failed` fact to flows, in addition to the `subscription.changed` fact every handled
event already gets (see `test_billing_stripe_webhook_endpoint.py`). Idempotent on the INVOICE:
a redelivered event and a Stripe retry of the same unpaid invoice both admit as the SAME
`source_event_id` (`events_mod.payment_failed_source_id`), so flows sees the fact exactly once
per failed invoice however many times Stripe resends it.

Same testcontainers-PG harness as the other identity billing endpoint suites (skips without
docker — see `conftest.requires_docker`); `events_mod.publish` is monkeypatched to a recorder
(the same seam `test_onboarding_event.py` uses) rather than pointed at a real flows-api, so this
proves WHAT gets published and with WHAT id, not the HTTP delivery `events_mod.publish` itself
already covers.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app import events as events_mod
from admin_api.app import main as main_module
from admin_api.app.billing.stripe_gateway import StripeClient
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker

WEBHOOK_SECRET = "whsec_test_only_dunning"  # TEST VALUE (AGENTS.md) — never a real Stripe secret
PRO_MONTHLY_PRICE = "price_test_pro_monthly_dunning"

STRIPE_ENV = {
    "STRIPE_SECRET_KEY": "sk_test_only_dunning",
    "STRIPE_WEBHOOK_SECRET": WEBHOOK_SECRET,
    "STRIPE_CHECKOUT_SUCCESS_URL": "https://app.example.com/billing?checkout=success",
    "STRIPE_CHECKOUT_CANCEL_URL": "https://app.example.com/billing?checkout=cancelled",
    "STRIPE_PORTAL_RETURN_URL": "https://app.example.com/billing",
    "STRIPE_PRICE_PRO_MONTHLY": PRO_MONTHLY_PRICE,
}


@pytest.fixture()
def published(monkeypatch):
    sent = []

    async def fake(event_type, source_event_id, subject_refs, **kw):
        sent.append({"event_type": event_type, "source_event_id": source_event_id,
                     "subject_refs": subject_refs})
        return True

    monkeypatch.setattr(events_mod, "publish", fake)
    return sent


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    for key, value in STRIPE_ENV.items():
        monkeypatch.setenv(key, value)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _create_user(client, email):
    return client.post("/admin/users", headers=_admin(), json={"email": email}).json()["id"]


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
    def __init__(self):
        self.subscriptions: dict[str, dict] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/v1/subscriptions/"):
            sub_id = path.rsplit("/", 1)[-1]
            sub = self.subscriptions.get(sub_id)
            if sub is None:
                return httpx.Response(404, json={"error": {"message": "no such subscription"}})
            return httpx.Response(200, json=sub)
        return httpx.Response(404, json={"error": {"message": f"unhandled path {path}"}})


def _wire_stripe(monkeypatch, server: _SubscriptionServer):
    transport = httpx.MockTransport(server.handler)
    monkeypatch.setattr(
        main_module, "_stripe_client",
        lambda: StripeClient(secret_key="sk_test_only_dunning", transport=transport),
    )


def _subscription(sub_id, customer_id, *, status="past_due", price=PRO_MONTHLY_PRICE):
    return {
        "id": sub_id, "customer": customer_id, "status": status,
        "cancel_at_period_end": False,
        "current_period_start": 1_700_000_000, "current_period_end": 1_702_592_000,
        "canceled_at": None,
        "items": {"data": [{"price": {"id": price}}]},
    }


def _invoice_failed_event(event_id, invoice_id, customer_id, subscription_id):
    return {"id": event_id, "type": "invoice.payment_failed", "data": {"object": {
        "id": invoice_id, "customer": customer_id, "subscription": subscription_id,
    }}}


# ── one payment.failed fact per failed invoice ──────────────────────────────────────────────────
def test_invoice_payment_failed_publishes_one_payment_failed_fact(client, monkeypatch, published):
    uid = _create_user(client, "dunning-mail@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_dun"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_dun"] = _subscription("sub_dun", "cus_dun")
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, _invoice_failed_event("evt_1", "in_dun_1", "cus_dun", "sub_dun"))
    assert r.status_code == 200, r.text

    fact_types = [e["event_type"] for e in published]
    assert fact_types.count("payment.failed") == 1
    assert fact_types.count("subscription.changed") == 1
    payment_fact = next(e for e in published if e["event_type"] == "payment.failed")
    assert payment_fact["subject_refs"] == {"subject": str(uid), "invoice_id": "in_dun_1"}
    assert payment_fact["source_event_id"] == events_mod.payment_failed_source_id(uid, "in_dun_1")


# ── idempotency: redelivery of the SAME event is a no-op-shaped id ───────────────────────────────
def test_redelivery_of_the_same_event_reuses_the_same_source_event_id(client, monkeypatch, published):
    uid = _create_user(client, "dunning-redeliver@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_redun"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_redun"] = _subscription("sub_redun", "cus_redun")
    _wire_stripe(monkeypatch, server)

    event = _invoice_failed_event("evt_redeliver", "in_redun_1", "cus_redun", "sub_redun")
    r1 = _post_webhook(client, event)
    r2 = _post_webhook(client, event)  # Stripe redelivery: identical body, identical event id
    assert r1.status_code == 200 and r2.status_code == 200

    payment_facts = [e for e in published if e["event_type"] == "payment.failed"]
    assert len(payment_facts) == 2, "the ADMIN-API SIDE publishes twice — flows' own admission " \
        "(source_event_id, flow) is what collapses this to one reaction, per " \
        "test_dunning_email.py's own redelivery/retry proof"
    assert payment_facts[0]["source_event_id"] == payment_facts[1]["source_event_id"]


# ── idempotency: a STRIPE RETRY (fresh event id, same invoice) still keys to one fact ────────────
def test_a_stripe_retry_of_the_same_invoice_keys_to_the_same_source_event_id(client, monkeypatch, published):
    """A fresh event id (Stripe's own dunning retry schedule) for the SAME unpaid invoice must
    resolve to the SAME `source_event_id` — the invoice, not the delivery, is what flows admits
    on once."""
    uid = _create_user(client, "dunning-retry@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_retry"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_retry"] = _subscription("sub_retry", "cus_retry")
    _wire_stripe(monkeypatch, server)

    _post_webhook(client, _invoice_failed_event("evt_retry_1", "in_retry_1", "cus_retry", "sub_retry"))
    _post_webhook(client, _invoice_failed_event("evt_retry_2", "in_retry_1", "cus_retry", "sub_retry"))

    payment_facts = [e for e in published if e["event_type"] == "payment.failed"]
    assert len(payment_facts) == 2
    assert payment_facts[0]["source_event_id"] == payment_facts[1]["source_event_id"]


# ── other handled event types do NOT publish payment.failed ─────────────────────────────────────
def test_other_event_types_publish_no_payment_failed_fact(client, monkeypatch, published):
    uid = _create_user(client, "not-dunning@vexa.ai")
    client.patch(f"/admin/users/{uid}", headers=_admin(),
                json={"data": {"stripe_customer_id": "cus_active"}})
    server = _SubscriptionServer()
    server.subscriptions["sub_active"] = _subscription("sub_active", "cus_active", status="active")
    _wire_stripe(monkeypatch, server)

    r = _post_webhook(client, {"id": "evt_active", "type": "invoice.paid", "data": {"object": {
        "id": "in_active_1", "customer": "cus_active", "subscription": "sub_active",
    }}})
    assert r.status_code == 200

    assert [e for e in published if e["event_type"] == "payment.failed"] == []
