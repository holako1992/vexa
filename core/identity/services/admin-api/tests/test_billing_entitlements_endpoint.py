"""DB-70 — `GET /user/entitlements`: auth (same tier as `/user/webhook`/`/user/transcription`)
and that a caller only ever sees their OWN resolved entitlements.

The resolution logic itself (every row of the acceptance table) is covered without docker in
`test_billing_entitlements.py`. This suite is about the wire: does the endpoint exist, does it
enforce the user tier's auth, and does it read the billing fields this caller's own admin-set
`data` carries — never another user's.

Same testcontainers-PG harness as the other identity suites (skips without docker).
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from admin_api.app import db as app_db
from admin_api.app.main import create_app
from admin_api.schema.models import Base, Meeting
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

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
    # DB-71: a real MeetingsUsagePort is wired in — a user with no meetings reads as counted-zero,
    # not unknown. NullUsagePort's unknown-vs-zero distinction is covered on its own in
    # test_billing_entitlements.py and the query-failure path below.
    assert body["usage"]["meetings_used"] == 0
    assert body["usage"]["minutes_used"] == 0


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


# --- DB-71: usage is now metered live from `meetings`, not always unknown ---

def _seed_meeting(pg_url, **fields):
    """Insert one `meetings` row directly (bypassing meeting-api — same table, same columns)."""
    engine = create_engine(pg_url)
    try:
        with Session(engine) as s:
            m = Meeting(**fields)
            s.add(m)
            s.commit()
            return m.id
    finally:
        engine.dispose()


def test_usage_reflects_joined_meetings_in_the_current_calendar_month(client, pg_url):
    user_id, token = _create_user_with_token(client, "usage-real@vexa.ai")
    now = datetime.now(UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    inside = month_start + timedelta(hours=2)

    # Consumed: the bot reached the room.
    _seed_meeting(pg_url, user_id=user_id, platform="google_meet", status="completed",
                 created_at=inside.replace(tzinfo=None),
                 start_time=inside.replace(tzinfo=None),
                 end_time=(inside + timedelta(minutes=15)).replace(tzinfo=None))
    # Not consumed: never got past awaiting_admission.
    _seed_meeting(pg_url, user_id=user_id, platform="google_meet", status="awaiting_admission",
                 created_at=inside.replace(tzinfo=None))

    r = client.get("/user/entitlements", headers={"X-API-Key": token})
    assert r.status_code == 200, r.text
    usage = r.json()["usage"]
    assert usage["meetings_used"] == 1  # only the completed row
    assert usage["minutes_used"] == 15


def test_usage_query_failure_reports_unknown_not_zero(client, monkeypatch):
    """A broken usage query must surface as `null` usage fields (200, unknown) — never `0`,
    which would read as "0 of 1 used" and let an over-quota user straight through."""
    _user_id, token = _create_user_with_token(client, "usage-broken@vexa.ai")

    def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated query failure")

    monkeypatch.setattr("admin_api.app.billing.meetings_usage.select", _boom)

    r = client.get("/user/entitlements", headers={"X-API-Key": token})
    assert r.status_code == 200, r.text
    usage = r.json()["usage"]
    assert usage["meetings_used"] is None
    assert usage["minutes_used"] is None
