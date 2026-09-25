"""DB-73 — `POST /billing/checkout` and `POST /billing/portal`: the request SHAPE sent to Stripe
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

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/v1/customers":
            return httpx.Response(200, json={"id": self.customer_id, "object": "customer"})
        if path == "/v1/checkout/sessions":
            return httpx.Response(200, json={"id": "cs_test_001", "url": "https://checkout.stripe.com/cs_test_001"})
        if path == "/v1/billing_portal/sessions":
            return httpx.Response(200, json={"id": "bps_test_001", "url": "https://billing.stripe.com/p/session/test"})
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
