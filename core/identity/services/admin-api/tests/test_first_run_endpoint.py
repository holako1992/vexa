"""`GET/PUT /user/first-run` over a real Postgres — the welcome belongs to the token's owner.

Same testcontainers-PG harness as the other identity suites (skips without docker). The pure rules
are in `test_first_run.py`; this file holds what only a database and a router can show: the state
survives a new session, is per-account, and an old account is not welcomed.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

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
        c.pg_url = pg_url
        yield c
    _dispose_async_engine()


def _account(client, email, scopes="bot"):
    uid = client.post("/admin/users", headers=_admin(), json={"email": email}).json()["id"]
    tok = client.post(f"/admin/users/{uid}/tokens?scopes={scopes}", headers=_admin()).json()["token"]
    return uid, {"X-API-Key": tok}


def _sql(client, statement, **params):
    eng = create_engine(client.pg_url)
    with eng.begin() as conn:
        conn.execute(text(statement), params)
    eng.dispose()


def _age(client, uid, seconds):
    """Make an account `seconds` older, the way time would — the stamp is the only thing moved."""
    _sql(client,
         "UPDATE users SET data = jsonb_set(data::jsonb, '{onboarding_completed_at}', "
         "to_jsonb((data::jsonb->>'onboarding_completed_at')::float - :s))::json WHERE id = :i",
         s=seconds, i=uid)


def _unstamp(client, uid):
    _sql(client, "UPDATE users SET data = (data::jsonb - 'onboarding_completed_at')::json "
                 "WHERE id = :i", i=uid)


def test_a_new_account_is_welcomed_and_the_step_survives_a_new_session(client):
    uid, h = _account(client, "fresh@vexa.ai")
    assert client.get("/user/first-run", headers=h).json() == {"state": "active", "step": "name"}
    r = client.put("/user/first-run", headers=h, json={"step": "calendar"})
    assert r.status_code == 200, r.text
    assert r.json() == {"state": "active", "step": "calendar"}
    # a second token — another browser, another device — sees the same place
    tok2 = client.post(f"/admin/users/{uid}/tokens?scopes=bot,tx", headers=_admin()).json()["token"]
    assert client.get("/user/first-run", headers={"X-API-Key": tok2}).json() == {
        "state": "active", "step": "calendar"}


@pytest.mark.parametrize("state", ["done", "skipped"])
def test_ending_the_welcome_is_for_good(client, state):
    _uid, h = _account(client, f"{state}@vexa.ai")
    assert client.put("/user/first-run", headers=h, json={"state": state}).json()["state"] == state
    assert client.get("/user/first-run", headers=h).json()["state"] == state
    again = client.put("/user/first-run", headers=h, json={"step": "name"})
    assert again.status_code == 200 and again.json()["state"] == state


def test_it_is_per_account(client):
    _a, ha = _account(client, "a@vexa.ai")
    _b, hb = _account(client, "b@vexa.ai")
    client.put("/user/first-run", headers=ha, json={"state": "skipped"})
    assert client.get("/user/first-run", headers=hb).json()["state"] == "active"


def test_an_old_or_unstamped_account_is_not_welcomed_and_cannot_write(client):
    old, ho = _account(client, "old@vexa.ai")
    _age(client, old, 30 * 24 * 3600)
    legacy, hl = _account(client, "legacy@vexa.ai")
    _unstamp(client, legacy)
    for h in (ho, hl):
        assert client.get("/user/first-run", headers=h).json()["state"] == "none"
        r = client.put("/user/first-run", headers=h, json={"step": "calendar"})
        assert r.status_code == 422, r.text


@pytest.mark.parametrize("body", [{}, {"step": "billing"}, {"state": "active"}, {"user_id": 1}])
def test_a_body_outside_the_vocabulary_is_a_422_with_the_list(client, body):
    _uid, h = _account(client, "bad@vexa.ai")
    r = client.put("/user/first-run", headers=h, json=body)
    assert r.status_code == 422
    assert client.get("/user/first-run", headers=h).json() == {"state": "active", "step": "name"}


def test_the_record_sits_beside_the_rest_of_the_account(client):
    uid, h = _account(client, "beside@vexa.ai")
    client.put("/user/calendar", headers=h, json={"bot_name": "Scribe"})
    client.put("/user/first-run", headers=h, json={"step": "meeting"})
    data = client.get(f"/admin/users/{uid}", headers=_admin()).json()["data"]
    assert data["calendar_bot_name"] == "Scribe"
    assert data["first_run"] == {"step": "meeting"}
    assert data["onboarding_completed_at"]


def test_a_missing_or_unknown_key_is_refused(client):
    assert client.get("/user/first-run").status_code in (401, 403)
    assert client.put("/user/first-run", json={"state": "done"}).status_code in (401, 403)
    assert client.get("/user/first-run", headers={"X-API-Key": "nope"}).status_code == 403
