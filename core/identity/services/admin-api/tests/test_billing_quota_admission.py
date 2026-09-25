"""DB-72 — the two admission-time doors meeting-api reads: `/internal/validate`'s combined
`max_concurrent` (the gateway's `x-user-limits`, the hot per-request path — no usage query here,
see the docstring on `main.get_bot_context` and `billing.catalog.effective_concurrent_cap`) and
`/internal/users/{id}/bot-context`'s `quota` block (the spawn-time-only door meeting-api's
`request_bot` already calls once per admission attempt).

Same testcontainers-PG harness as the other identity suites (skips without docker) — see
`test_billing_entitlements_endpoint.py`, which this mirrors.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine, _internal

pytestmark = requires_docker

UTC = timezone.utc


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    monkeypatch.delenv("BILLING_UPGRADE_URL", raising=False)
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


# ── /internal/validate: max_concurrent is the combined plan+column number ───────────────────────

def test_validate_max_concurrent_untouched_free_user_drops_from_3_to_1(client):
    """PRODUCT CHANGE, asserted directly: a Free user nobody has ever PATCHed carries the legacy
    `max_concurrent_bots` default (3) on their row, but /internal/validate now returns the Free
    plan's 1 — the exact change DB-72's report states for every existing Free user."""
    _user_id, token = _create_user_with_token(client, "free-cap@vexa.ai")
    r = client.post("/internal/validate", headers=_internal(), json={"token": token})
    assert r.status_code == 200, r.text
    assert r.json()["max_concurrent"] == 1


def test_validate_max_concurrent_untouched_pro_user_gets_2_not_the_legacy_default(client):
    user_id, token = _create_user_with_token(client, "pro-cap@vexa.ai")
    client.patch(f"/admin/users/{user_id}", headers=_admin(),
                json={"data": {"subscription_status": "active", "subscription_tier": "pro"}})
    r = client.post("/internal/validate", headers=_internal(), json={"token": token})
    assert r.status_code == 200, r.text
    assert r.json()["max_concurrent"] == 2


def test_validate_max_concurrent_explicit_override_narrows_below_the_plan(client):
    """An operator who explicitly set max_concurrent_bots=1 on a Pro user narrows them below their
    plan's 2 — the pre-DB-77 hard-ceiling meaning of the column."""
    user_id, token = _create_user_with_token(client, "pro-capped@vexa.ai")
    client.patch(f"/admin/users/{user_id}", headers=_admin(),
                json={"data": {"subscription_status": "active", "subscription_tier": "pro"},
                      "max_concurrent_bots": 1})
    r = client.post("/internal/validate", headers=_internal(), json={"token": token})
    assert r.status_code == 200, r.text
    assert r.json()["max_concurrent"] == 1


# ── /internal/users/{id}/bot-context: the `quota` block ─────────────────────────────────────────

def test_bot_context_quota_absent_for_unlimited_plan(client):
    user_id, _token = _create_user_with_token(client, "team-quota@vexa.ai")
    client.patch(f"/admin/users/{user_id}", headers=_admin(),
                json={"data": {"subscription_status": "active", "subscription_tier": "team"}})
    r = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert r.status_code == 200, r.text
    assert "quota" not in r.json()


def test_bot_context_quota_present_and_counted_for_free_plan(client):
    user_id, _token = _create_user_with_token(client, "free-quota@vexa.ai")
    r = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert r.status_code == 200, r.text
    quota = r.json()["quota"]
    assert quota["meetings_per_month"] == 1
    assert quota["meetings_used"] == 0  # a real MeetingsUsagePort count, not unknown
    assert quota["resets_at"]
    assert quota["upgrade_url"] is None  # BILLING_UPGRADE_URL unset in this deployment


def test_bot_context_quota_carries_the_configured_upgrade_url(client, monkeypatch):
    monkeypatch.setenv("BILLING_UPGRADE_URL", "https://vexa.ai/pricing")
    user_id, _token = _create_user_with_token(client, "free-quota-url@vexa.ai")
    r = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert r.status_code == 200, r.text
    assert r.json()["quota"]["upgrade_url"] == "https://vexa.ai/pricing"


def test_bot_context_max_concurrent_matches_validate(client):
    """Auto-join reads its per-user cap off bot-context; a manual POST /bots reads it off
    /internal/validate's x-user-limits. Both MUST resolve to the same number for one user, or the
    two admission paths enforce two different caps."""
    user_id, token = _create_user_with_token(client, "parity-check@vexa.ai")
    validate_cap = client.post(
        "/internal/validate", headers=_internal(), json={"token": token}
    ).json()["max_concurrent"]
    bot_context_cap = client.get(
        f"/internal/users/{user_id}/bot-context", headers=_internal()
    ).json()["max_concurrent"]
    assert validate_cap == bot_context_cap == 1  # untouched Free user


def test_bot_context_quota_unknown_usage_on_query_failure(client, monkeypatch):
    """The same fail-UNKNOWN-never-0 rule `test_billing_entitlements_endpoint.py` proves for
    `/user/entitlements` also holds for the spawn-time `quota` block."""
    user_id, _token = _create_user_with_token(client, "quota-broken@vexa.ai")

    def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated query failure")

    monkeypatch.setattr("admin_api.app.billing.meetings_usage.select", _boom)

    r = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert r.status_code == 200, r.text
    assert r.json()["quota"]["meetings_used"] is None
