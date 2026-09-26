"""DB-72 — the two admission-time doors meeting-api reads: `/internal/validate`'s combined
`max_concurrent` (the gateway's `x-user-limits`, the hot per-request path — no usage query here,
see the docstring on `main.get_bot_context` and `billing.catalog.effective_concurrent_cap`) and
`/internal/users/{id}/bot-context`'s `quota` block (the spawn-time-only door meeting-api's
`request_bot` already calls once per admission attempt).

Same testcontainers-PG harness as the other identity suites (skips without docker) — see
`test_billing_entitlements_endpoint.py`, which this mirrors.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from admin_api.app import db as app_db
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import (
    ADMIN_TOKEN,
    INTERNAL_SECRET,
    _admin,
    _data,
    _dispose_async_engine,
    _internal,
)

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


# ── /internal/users/{id}/bot-context: `max_minutes_per_meeting` — the per-meeting minute cap
#    meeting-api combines with the caller's own `automatic_leave.max_bot_time` by minimum ────────

def test_bot_context_max_minutes_per_meeting_present_for_free_plan(client):
    user_id, _token = _create_user_with_token(client, "free-minutes@vexa.ai")
    r = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert r.status_code == 200, r.text
    assert r.json()["max_minutes_per_meeting"] == 60


def test_bot_context_max_minutes_per_meeting_present_for_unlimited_meeting_count_plan(client):
    """Team has NO monthly meeting quota (`quota` is absent, see the test above it) but DOES have a
    per-meeting minute cap — the two fields are independent axes, and gating this one on
    `meetings_per_month` (as `quota` is) would silently drop it for every paid plan."""
    user_id, _token = _create_user_with_token(client, "team-minutes@vexa.ai")
    client.patch(f"/admin/users/{user_id}", headers=_admin(),
                json={"data": {"subscription_status": "active", "subscription_tier": "team"}})
    r = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert r.status_code == 200, r.text
    body = r.json()
    assert "quota" not in body
    assert body["max_minutes_per_meeting"] == 240


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


# ── DB-77 admin overrides: the write path (PATCH), and both doors reflecting it ─────────────────

def test_patch_plan_override_unknown_plan_id_is_422(client):
    user_id, _token = _create_user_with_token(client, "bad-override@vexa.ai")
    r = client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"plan_override": "enterprise"})
    assert r.status_code == 422, r.text


def test_patch_quota_bonus_negative_is_422(client):
    user_id, _token = _create_user_with_token(client, "bad-bonus@vexa.ai")
    r = client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"quota_bonus": -1})
    assert r.status_code == 422, r.text


def test_patch_plan_override_comps_a_free_user_to_team_everywhere(client):
    """One PATCH, and BOTH admission doors — /internal/validate's max_concurrent (the gateway's
    x-user-limits) and /internal/users/{id}/bot-context (meeting-api's quota check) — reflect it
    at once, because both read through the same `resolve_plan`."""
    user_id, token = _create_user_with_token(client, "comped-to-team@vexa.ai")
    patched = client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"plan_override": "team"})
    assert patched.status_code == 200, patched.text

    validated = client.post("/internal/validate", headers=_internal(), json={"token": token})
    assert validated.json()["max_concurrent"] == 5  # Team's concurrent_bots

    ctx = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert ctx.json()["max_concurrent"] == 5
    assert "quota" not in ctx.json()  # Team's meetings_per_month is unlimited


def test_patch_clearing_plan_override_reverts_to_the_stripe_tier(client):
    user_id, token = _create_user_with_token(client, "cleared-override@vexa.ai")
    client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"plan_override": "team"})
    cleared = client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"plan_override": None})
    assert cleared.status_code == 200, cleared.text
    validated = client.post("/internal/validate", headers=_internal(), json={"token": token})
    assert validated.json()["max_concurrent"] == 1  # back to the untouched Free user's cap


def test_patch_quota_bonus_raises_the_free_monthly_quota_at_bot_context(client):
    user_id, _token = _create_user_with_token(client, "bonus-meeting@vexa.ai")
    patched = client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"quota_bonus": 1})
    assert patched.status_code == 200, patched.text
    assert _data(patched)["quota_bonus"] == 1
    assert "quota_bonus_period_start" in _data(patched)

    ctx = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert ctx.json()["quota"]["meetings_per_month"] == 1 + 1  # Free's 1 + the comp


def test_patch_quota_bonus_stamped_period_does_not_apply_to_a_stale_stamp(client, pg_url):
    """A bonus whose stamped period does not match the CURRENT resolved period (simulating one
    granted last month and never refreshed, or a webhook rolling the Stripe period forward
    underneath it) is not honoured — it does not carry over. The PATCH endpoint always stamps
    "now"; a stale stamp can only be simulated with a raw write, which is what this does."""
    user_id, _token = _create_user_with_token(client, "stale-bonus@vexa.ai")
    patched = client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"quota_bonus": 1})
    assert patched.status_code == 200, patched.text
    ctx_fresh = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert ctx_fresh.json()["quota"]["meetings_per_month"] == 1 + 1  # the bonus is live

    engine = create_engine(pg_url)
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE users SET data = data || CAST(:patch AS jsonb) WHERE id = :user_id"
            ),
            {"user_id": user_id, "patch": json.dumps({"quota_bonus_period_start": 1})},  # 1970
        )
    engine.dispose()

    ctx_stale = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert ctx_stale.json()["quota"]["meetings_per_month"] == 1  # bonus no longer applies


def test_patch_quota_bonus_none_clears_it(client):
    user_id, _token = _create_user_with_token(client, "cleared-bonus@vexa.ai")
    client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"quota_bonus": 1})
    cleared = client.patch(f"/admin/users/{user_id}", headers=_admin(), json={"quota_bonus": None})
    assert cleared.status_code == 200, cleared.text
    assert "quota_bonus" not in _data(cleared)
    assert "quota_bonus_period_start" not in _data(cleared)
    ctx = client.get(f"/internal/users/{user_id}/bot-context", headers=_internal())
    assert ctx.json()["quota"]["meetings_per_month"] == 1  # back to Free's bare limit
