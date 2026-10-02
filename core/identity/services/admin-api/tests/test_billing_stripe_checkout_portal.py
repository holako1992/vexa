"""`POST /billing/checkout` and `POST /billing/portal`: the request SHAPE sent to Stripe
(via an `httpx.MockTransport` — never the real network), customer creation on first use and reuse
after, and the typed 503 when Stripe is not configured.

Same testcontainers-PG harness as the other identity billing suites (skips without docker) — see
`test_billing_entitlements_endpoint.py`, which this mirrors. `admin_api.app.main._stripe_client` is
monkeypatched to hand back a `StripeClient` wired to the mock transport, so no real Stripe account
is ever needed and no network call ever leaves the test process.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app import main as main_module
from admin_api.app.billing import prices as billing_prices
from admin_api.app.billing.stripe_gateway import StripeClient
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker

STRIPE_ENV = {
    "STRIPE_SECRET_KEY": "sk_test_only_1234",  # TEST VALUE (AGENTS.md) — never a real Stripe key
    "STRIPE_WEBHOOK_SECRET": "whsec_test_only_1234",
    "STRIPE_CHECKOUT_SUCCESS_URL": "https://app.example.com/billing?checkout=success",
    "STRIPE_CHECKOUT_CANCEL_URL": "https://app.example.com/billing?checkout=cancelled",
    "STRIPE_PORTAL_RETURN_URL": "https://app.example.com/billing",
    "STRIPE_PRICE_PRO_MONTHLY": "price_test_pro_monthly",
    "STRIPE_PRICE_PRO_YEARLY": "price_test_pro_yearly",
    "STRIPE_PRICE_TEAM_MONTHLY": "price_test_team_monthly",
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
    for key, value in STRIPE_ENV.items():
        monkeypatch.setenv(key, value)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _create_user_with_token(client, email, scopes="bot,tx"):
    user_id = client.post("/admin/users", headers=_admin(), json={"email": email}).json()["id"]
    token = client.post(
        f"/admin/users/{user_id}/tokens?scopes={scopes}", headers=_admin()
    ).json()["token"]
    return user_id, token


class _Recorder:
    """A tiny call log + canned-response table for `httpx.MockTransport`, so a test can both
    assert on the exact request Stripe would have received AND control what comes back."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.customer_id = "cus_test_001"
        #: The customer's subscriptions, as `GET /v1/subscriptions` lists them and
        #: `GET|POST /v1/subscriptions/{id}` reads and changes them.
        self.subscriptions: dict[str, dict] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/v1/customers":
            return httpx.Response(200, json={"id": self.customer_id, "object": "customer"})
        if path == "/v1/checkout/sessions":
            return httpx.Response(200, json={"id": "cs_test_001", "url": "https://checkout.stripe.com/cs_test_001"})
        if path == "/v1/billing_portal/sessions":
            return httpx.Response(200, json={"id": "bps_test_001", "url": "https://billing.stripe.com/p/session/test"})
        if path == "/v1/subscriptions":
            return httpx.Response(200, json={"data": list(self.subscriptions.values())})
        if path.startswith("/v1/subscriptions/"):
            sub = self.subscriptions.get(path.rsplit("/", 1)[-1])
            if sub is None:
                return httpx.Response(404, json={"error": {"message": "No such subscription"}})
            if request.method == "POST":
                form = _form(request)
                sub["items"]["data"][0]["price"]["id"] = form["items[0][price]"]
            return httpx.Response(200, json=sub)
        if path.startswith("/v1/prices/"):
            price_id = path.rsplit("/", 1)[-1]
            interval = "year" if price_id.endswith("yearly") else "month"
            return httpx.Response(200, json={
                "id": price_id, "unit_amount": 500, "currency": "usd", "active": True,
                "recurring": {"interval": interval},
            })
        return httpx.Response(404, json={"error": {"message": f"unhandled path {path}"}})


def _wire_stripe(monkeypatch, recorder: _Recorder):
    transport = httpx.MockTransport(recorder.handler)
    monkeypatch.setattr(
        main_module, "_stripe_client",
        lambda: StripeClient(secret_key="sk_test_only_1234", transport=transport),
    )


def _form(request: httpx.Request) -> dict:
    return {k: v[0] for k, v in parse_qs(request.content.decode()).items()}


# ── checkout ──────────────────────────────────────────────────────────────────────────────────

def test_checkout_creates_a_customer_on_first_use_and_reuses_it(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "checkout-first-use@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)

    r1 = client.post("/billing/checkout", headers={"X-API-Key": token},
                     json={"plan": "pro", "interval": "month"})
    assert r1.status_code == 200, r1.text
    assert r1.json()["url"] == "https://checkout.stripe.com/cs_test_001"
    paths = [req.url.path for req in recorder.requests]
    assert paths == ["/v1/customers", "/v1/checkout/sessions"], "first checkout creates a customer"

    r2 = client.post("/billing/checkout", headers={"X-API-Key": token},
                     json={"plan": "pro", "interval": "month"})
    assert r2.status_code == 200, r2.text
    paths_after = [req.url.path for req in recorder.requests]
    # No SECOND /v1/customers call — the stored stripe_customer_id is reused.
    assert paths_after.count("/v1/customers") == 1, "a second checkout must reuse the stored customer"
    assert paths_after.count("/v1/checkout/sessions") == 2


def test_checkout_session_request_shape(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "checkout-shape@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)

    r = client.post("/billing/checkout", headers={"X-API-Key": token},
                    json={"plan": "pro", "interval": "month"})
    assert r.status_code == 200, r.text
    session_req = next(req for req in recorder.requests if req.url.path == "/v1/checkout/sessions")
    body = _form(session_req)
    assert body["mode"] == "subscription"
    assert body["customer"] == recorder.customer_id
    assert body["client_reference_id"] == str(_uid)
    assert body["success_url"] == STRIPE_ENV["STRIPE_CHECKOUT_SUCCESS_URL"]
    assert body["cancel_url"] == STRIPE_ENV["STRIPE_CHECKOUT_CANCEL_URL"]
    assert body["line_items[0][price]"] == STRIPE_ENV["STRIPE_PRICE_PRO_MONTHLY"]
    assert session_req.headers["authorization"] == "Bearer sk_test_only_1234"


def test_checkout_for_an_unconfigured_plan_interval_503s(client, monkeypatch):
    """`team`/`year` has no `STRIPE_PRICE_TEAM_YEARLY` set in this fixture's env — the plan exists
    in the catalog, but this deployment does not sell it, which must 503 by NAME, not guess a price."""
    _uid, token = _create_user_with_token(client, "checkout-unsold@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    r = client.post("/billing/checkout", headers={"X-API-Key": token},
                    json={"plan": "team", "interval": "year"})
    assert r.status_code == 503
    assert "STRIPE_PRICE_TEAM_YEARLY" in r.json()["detail"]
    assert recorder.requests == [], "an unsold plan must never reach Stripe"


def test_checkout_rejects_the_free_plan(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "checkout-free@vexa.ai")
    r = client.post("/billing/checkout", headers={"X-API-Key": token},
                    json={"plan": "free", "interval": "month"})
    assert r.status_code == 422


def test_checkout_with_no_stripe_config_503s(client, monkeypatch):
    for key in STRIPE_ENV:
        monkeypatch.delenv(key, raising=False)
    _uid, token = _create_user_with_token(client, "checkout-unconfigured@vexa.ai")
    r = client.post("/billing/checkout", headers={"X-API-Key": token},
                    json={"plan": "pro", "interval": "month"})
    assert r.status_code == 503
    assert "STRIPE_SECRET_KEY" in r.json()["detail"]
    assert "STRIPE_WEBHOOK_SECRET" in r.json()["detail"]


def test_checkout_requires_a_valid_api_key(client):
    r = client.post("/billing/checkout", json={"plan": "pro", "interval": "month"})
    assert r.status_code == 401


# ── portal ────────────────────────────────────────────────────────────────────────────────────

def test_portal_409s_with_no_customer_on_file(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "portal-no-customer@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    r = client.post("/billing/portal", headers={"X-API-Key": token})
    assert r.status_code == 409
    assert recorder.requests == []


def test_portal_session_request_shape_after_checkout(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "portal-shape@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    checkout = client.post("/billing/checkout", headers={"X-API-Key": token},
                           json={"plan": "pro", "interval": "month"})
    assert checkout.status_code == 200, checkout.text

    r = client.post("/billing/portal", headers={"X-API-Key": token})
    assert r.status_code == 200, r.text
    assert r.json()["url"] == "https://billing.stripe.com/p/session/test"
    portal_req = next(req for req in recorder.requests if req.url.path == "/v1/billing_portal/sessions")
    body = _form(portal_req)
    assert body["customer"] == recorder.customer_id
    assert body["return_url"] == STRIPE_ENV["STRIPE_PORTAL_RETURN_URL"]


def test_portal_with_no_stripe_config_503s(client, monkeypatch):
    for key in STRIPE_ENV:
        monkeypatch.delenv(key, raising=False)
    _uid, token = _create_user_with_token(client, "portal-unconfigured@vexa.ai")
    r = client.post("/billing/portal", headers={"X-API-Key": token})
    assert r.status_code == 503


# ── prices ────────────────────────────────────────────────────────────────────────────────────

def test_prices_lists_each_configured_price_as_stripe_states_it(client, monkeypatch):
    """The fixture env configures three of the four prices — the unconfigured team/year is not
    listed, and nothing about an amount comes from anywhere but Stripe's answer."""
    billing_prices.clear_cache()
    _uid, token = _create_user_with_token(client, "prices@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    r = client.get("/billing/prices", headers={"X-API-Key": token})
    assert r.status_code == 200, r.text
    assert r.json() == {"prices": [
        {"plan": "pro", "interval": "month", "unit_amount": 500, "currency": "usd"},
        {"plan": "pro", "interval": "year", "unit_amount": 500, "currency": "usd"},
        {"plan": "team", "interval": "month", "unit_amount": 500, "currency": "usd"},
    ]}
    assert [req.url.path for req in recorder.requests] == [
        "/v1/prices/price_test_pro_monthly", "/v1/prices/price_test_pro_yearly",
        "/v1/prices/price_test_team_monthly",
    ]
    billing_prices.clear_cache()


def test_prices_with_no_stripe_config_503s(client, monkeypatch):
    for key in STRIPE_ENV:
        monkeypatch.delenv(key, raising=False)
    _uid, token = _create_user_with_token(client, "prices-unconfigured@vexa.ai")
    r = client.get("/billing/prices", headers={"X-API-Key": token})
    assert r.status_code == 503


def test_prices_requires_a_valid_api_key(client):
    assert client.get("/billing/prices").status_code == 401


# ── one subscription per customer ─────────────────────────────────────────────────────────────

def _live_sub(sub_id="sub_live_1", price="price_test_pro_monthly", status="active"):
    return {
        "id": sub_id, "customer": "cus_test_001", "status": status, "cancel_at_period_end": False,
        "items": {"data": [{"id": "si_1", "price": {"id": price},
                            "current_period_start": 1_790_000_000, "current_period_end": 1_792_600_000}]},
        "schedule": None,
    }


def test_checkout_refuses_a_second_subscription_while_one_is_live(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "checkout-second@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    first = client.post("/billing/checkout", headers={"X-API-Key": token},
                        json={"plan": "pro", "interval": "month"})
    assert first.status_code == 200, first.text
    recorder.subscriptions["sub_live_1"] = _live_sub()  # the purchase completed in Stripe

    second = client.post("/billing/checkout", headers={"X-API-Key": token},
                         json={"plan": "team", "interval": "month"})
    assert second.status_code == 409
    assert "already have a subscription" in second.json()["detail"]
    assert [r.url.path for r in recorder.requests].count("/v1/checkout/sessions") == 1


def test_checkout_is_allowed_again_once_the_old_subscription_has_ended(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "checkout-after-end@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    client.post("/billing/checkout", headers={"X-API-Key": token}, json={"plan": "pro", "interval": "month"})
    recorder.subscriptions["sub_old"] = _live_sub("sub_old", status="canceled")
    r = client.post("/billing/checkout", headers={"X-API-Key": token}, json={"plan": "pro", "interval": "month"})
    assert r.status_code == 200, r.text


# ── switching plans ───────────────────────────────────────────────────────────────────────────

def _subscribed_user(client, recorder, email, price="price_test_pro_monthly"):
    uid, token = _create_user_with_token(client, email)
    recorder.subscriptions["sub_live_1"] = _live_sub(price=price)
    client.patch(f"/admin/users/{uid}", headers=_admin(), json={"data": {
        "stripe_customer_id": "cus_test_001", "stripe_subscription_id": "sub_live_1",
        "subscription_status": "active", "subscription_tier": "pro", "subscription_interval": "month",
    }})
    return uid, token


def test_change_upgrades_in_place_and_writes_the_new_plan(client, monkeypatch):
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    uid, token = _subscribed_user(client, recorder, "change-up@vexa.ai")

    r = client.post("/billing/change", headers={"X-API-Key": token}, json={"plan": "team", "interval": "month"})
    assert r.status_code == 200, r.text
    assert r.json() == {"effective": "now"}
    update = next(q for q in recorder.requests if q.method == "POST" and q.url.path == "/v1/subscriptions/sub_live_1")
    assert _form(update) == {"items[0][id]": "si_1", "items[0][price]": "price_test_team_monthly",
                             "proration_behavior": "none"}
    ent = client.get("/user/entitlements", headers={"X-API-Key": token}).json()
    assert ent["plan_id"] == "team"
    assert ent["subscription"] == {"plan": "team", "interval": "month", "pending_change": None}


def test_change_without_a_subscription_409s_before_reaching_stripe(client, monkeypatch):
    _uid, token = _create_user_with_token(client, "change-none@vexa.ai")
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    r = client.post("/billing/change", headers={"X-API-Key": token}, json={"plan": "team", "interval": "month"})
    assert r.status_code == 409
    assert recorder.requests == []


def test_change_rejects_the_free_plan(client, monkeypatch):
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    _uid, token = _subscribed_user(client, recorder, "change-free@vexa.ai")
    r = client.post("/billing/change", headers={"X-API-Key": token}, json={"plan": "free", "interval": "month"})
    assert r.status_code == 422


def test_a_stripe_refusal_is_relayed_as_a_502_with_stripes_reason(client, monkeypatch):
    recorder = _Recorder()
    _wire_stripe(monkeypatch, recorder)
    _uid, token = _subscribed_user(client, recorder, "change-refused@vexa.ai")
    del recorder.subscriptions["sub_live_1"]  # Stripe answers 404 "No such subscription"
    r = client.post("/billing/change", headers={"X-API-Key": token}, json={"plan": "team", "interval": "month"})
    assert r.status_code == 502
    assert r.json()["detail"] == "Stripe refused the request: No such subscription"


def test_change_requires_a_valid_api_key(client):
    assert client.post("/billing/change", json={"plan": "team", "interval": "month"}).status_code == 401
