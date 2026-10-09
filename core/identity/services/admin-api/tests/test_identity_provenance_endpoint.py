"""Sign-in provenance end to end: docker-gated (same fixture shape as
`test_signup_disposable_domain.py`). Create with a claim, PATCH upgrade / no downgrade, the 422
refusals, and the gate's reach into `GET /user/entitlements` and the spawn-time bot-context.
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

INTERNAL = {"X-Internal-Secret": INTERNAL_SECRET}


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


def _create(client, email, **claim):
    r = client.post("/admin/users", headers=_admin(), json={"email": email, **claim})
    assert r.status_code == 201, r.text
    return r.json()


def _token(client, user_id):
    return client.post(f"/admin/users/{user_id}/tokens?scopes=bot,tx",
                       headers=_admin()).json()["token"]


def _identity(client, user_id):
    return client.get(f"/admin/users/{user_id}", headers=_admin()).json()["data"].get("identity")


def _bot_context(client, user_id):
    return client.get(f"/internal/users/{user_id}/bot-context", headers=INTERNAL).json()


def test_create_records_the_claim(client):
    u = _create(client, "g@acme.test", identity_provider="google", email_verified=True)
    rec = _identity(client, u["id"])
    assert rec["provider"] == "google" and rec["email_verified"] is True and rec["verified_at"]


def test_create_without_a_claim_stores_no_record(client):
    u = _create(client, "api@acme.test")
    assert _identity(client, u["id"]) is None


def test_patch_upgrades_an_unverified_record_and_never_downgrades(client):
    u = _create(client, "up@acme.test", identity_provider="email", email_verified=False)
    assert _identity(client, u["id"])["email_verified"] is False

    r = client.patch(f"/admin/users/{u['id']}", headers=_admin(),
                     json={"identity_provider": "google", "email_verified": True})
    assert r.status_code == 200, r.text
    assert _identity(client, u["id"])["email_verified"] is True

    r = client.patch(f"/admin/users/{u['id']}", headers=_admin(),
                     json={"identity_provider": "email", "email_verified": False})
    assert r.status_code == 200, r.text
    rec = _identity(client, u["id"])
    assert rec["email_verified"] is True and rec["provider"] == "google"


def test_patch_records_a_claim_on_an_account_that_had_none(client):
    u = _create(client, "legacy@acme.test")
    client.patch(f"/admin/users/{u['id']}", headers=_admin(),
                 json={"identity_provider": "microsoft", "email_verified": True})
    assert _identity(client, u["id"])["provider"] == "microsoft"


@pytest.mark.parametrize("claim", [
    {"identity_provider": "github", "email_verified": True},
    {"identity_provider": "google", "email_verified": "yes"},
    {"identity_provider": "google"},
    {"email_verified": True},
])
def test_malformed_claims_are_422_on_create_and_patch(client, claim):
    r = client.post("/admin/users", headers=_admin(), json={"email": "bad@acme.test", **claim})
    assert r.status_code == 422, r.text
    u = _create(client, "ok@acme.test")
    r = client.patch(f"/admin/users/{u['id']}", headers=_admin(), json=claim)
    assert r.status_code == 422, r.text


def test_unverified_free_user_has_zero_allowance_and_the_reason_everywhere(client):
    u = _create(client, "unv@acme.test", identity_provider="email", email_verified=False)
    token = _token(client, u["id"])

    ent = client.get("/user/entitlements", headers={"X-API-Key": token}).json()
    assert ent["limits"]["meetings_per_month"] == 0
    assert ent["reason"] == "identity_unverified"

    ctx = _bot_context(client, u["id"])
    assert ctx["quota"]["meetings_per_month"] == 0
    assert ctx["quota"]["reason"] == "identity_unverified"


def test_unrecorded_and_verified_users_keep_their_free_meeting(client):
    for email, claim in (("none@acme.test", {}),
                         ("ver@acme.test", {"identity_provider": "google", "email_verified": True})):
        u = _create(client, email, **claim)
        ctx = _bot_context(client, u["id"])
        assert ctx["quota"]["meetings_per_month"] == 1
        assert "reason" not in ctx["quota"]
        token = _token(client, u["id"])
        assert client.get("/user/entitlements", headers={"X-API-Key": token}).json()["reason"] is None


def test_plan_override_lifts_the_gate_and_verification_lifts_it_too(client):
    u = _create(client, "lift@acme.test", identity_provider="email", email_verified=False)
    client.patch(f"/admin/users/{u['id']}", headers=_admin(), json={"plan_override": "pro"})
    assert "quota" not in _bot_context(client, u["id"])  # pro: unlimited

    client.patch(f"/admin/users/{u['id']}", headers=_admin(), json={"plan_override": None})
    client.patch(f"/admin/users/{u['id']}", headers=_admin(),
                 json={"identity_provider": "google", "email_verified": True})
    assert _bot_context(client, u["id"])["quota"]["meetings_per_month"] == 1


# ── display name: filled from the sign-in profile when the account has none ───────────────────

def test_patch_sets_a_trimmed_name(client):
    uid = _create(client, "named@vexa.ai")["id"]
    r = client.patch(f"/admin/users/{uid}", headers=_admin(), json={"name": "  Ada Lovelace "})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Ada Lovelace"
    assert client.get(f"/admin/users/{uid}", headers=_admin()).json()["name"] == "Ada Lovelace"


@pytest.mark.parametrize("name", ["", "   ", "x" * 101])
def test_a_blank_or_overlong_name_is_422(client, name):
    uid = _create(client, "bad-name@vexa.ai")["id"]
    assert client.patch(f"/admin/users/{uid}", headers=_admin(), json={"name": name}).status_code == 422


def test_create_stores_the_name_it_is_given(client):
    r = client.post("/admin/users", headers=_admin(), json={"email": "created-named@vexa.ai", "name": "Grace Hopper"})
    assert r.status_code in (200, 201), r.text
    assert r.json()["name"] == "Grace Hopper"
