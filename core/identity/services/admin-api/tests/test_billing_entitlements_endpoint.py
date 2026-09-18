"""DB-70 — `GET /user/entitlements`: auth (same tier as `/user/webhook`/`/user/transcription`)
and that a caller only ever sees their OWN resolved entitlements.

The resolution logic itself (every row of the acceptance table) is covered without docker in
`test_billing_entitlements.py`. This suite is about the wire: does the endpoint exist, does it
enforce the user tier's auth, and does it read the billing fields this caller's own admin-set
`data` carries — never another user's.

Same testcontainers-PG harness as the other identity suites (skips without docker).
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
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


def test_no_api_key_is_401(client):
    r = client.get("/user/entitlements")
    assert r.status_code == 401


def test_valid_key_defaults_to_free_plan(client):
    _user_id, token = _create_user_with_token(client, "free-plan@vexa.ai")
    r = client.get("/user/entitlements", headers={"X-API-Key": token})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan_id"] == "free"
    assert body["limits"]["concurrent_bots"] == 1
    assert body["limits"]["meetings_per_month"] == 1
    assert body["usage"]["meetings_used"] is None  # NullUsagePort — unknown, not zero
    assert body["usage"]["minutes_used"] is None


def test_valid_key_reads_own_billing_data_not_defaults(client):
    user_id, token = _create_user_with_token(client, "pro-plan@vexa.ai")
    r = client.patch(
        f"/admin/users/{user_id}", headers=_admin(),
        json={"data": {"subscription_status": "active", "subscription_tier": "pro"}},
    )
    assert r.status_code == 200, r.text

    r = client.get("/user/entitlements", headers={"X-API-Key": token})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan_id"] == "pro"
    assert body["limits"]["concurrent_bots"] == 2
    assert body["limits"]["meetings_per_month"] is None  # unlimited


def test_caller_never_sees_another_users_entitlements(client):
    _free_id, free_token = _create_user_with_token(client, "still-free@vexa.ai")
    pro_id, _pro_token = _create_user_with_token(client, "other-pro@vexa.ai")
    r = client.patch(
        f"/admin/users/{pro_id}", headers=_admin(),
        json={"data": {"subscription_status": "active", "subscription_tier": "team"}},
    )
    assert r.status_code == 200, r.text

    # The FREE caller's own token must resolve to free, regardless of what the OTHER user (now
    # on `team`) has set on their own account.
    r = client.get("/user/entitlements", headers={"X-API-Key": free_token})
    assert r.status_code == 200, r.text
    assert r.json()["plan_id"] == "free"


def test_invalid_key_is_403(client):
    r = client.get("/user/entitlements", headers={"X-API-Key": "not-a-real-token"})
    assert r.status_code == 403
