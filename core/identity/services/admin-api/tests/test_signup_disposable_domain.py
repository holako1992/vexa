"""This trial-abuse floor at the `POST /admin/users` boundary — docker-gated (mirrors
`test_email_case_folding.py`'s fixture shape exactly). Pure matching/override logic is covered
without docker in `test_disposable_domains.py`; this file proves the wiring: the refusal is a
typed 422, an existing account is never locked out, and the operator override works end to end.
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

DISPOSABLE_EMAIL = "someone@mailinator.com"
ORDINARY_EMAIL = "someone@acme.test"


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    monkeypatch.delenv("SIGNUP_ALLOW_DISPOSABLE", raising=False)
    monkeypatch.delenv("SIGNUP_DISPOSABLE_EXTRA_DOMAINS", raising=False)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def test_a_disposable_domain_signup_is_refused_with_a_typed_422(client):
    r = client.post("/admin/users", headers=_admin(), json={"email": DISPOSABLE_EMAIL})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "disposable_email_domain"


def test_an_ordinary_domain_signup_still_succeeds(client):
    r = client.post("/admin/users", headers=_admin(), json={"email": ORDINARY_EMAIL})
    assert r.status_code == 201, r.text


def test_the_operator_override_lets_a_disposable_domain_through(client, monkeypatch):
    monkeypatch.setenv("SIGNUP_ALLOW_DISPOSABLE", "true")
    r = client.post("/admin/users", headers=_admin(), json={"email": DISPOSABLE_EMAIL})
    assert r.status_code == 201, r.text


def test_an_account_created_under_the_operator_override_is_never_locked_out_later(client, monkeypatch):
    """The block only ever runs on the INSERT branch of the create path — an address that already
    has a row returns 200 on the existing-lookup and never reaches the disposable check at all.
    Create a disposable-domain account under the override (simulating one created before the
    domain was ever listed, or before this feature existed), then confirm a plain find-or-create
    call with the override OFF still resolves it rather than refusing the now-existing account."""
    monkeypatch.setenv("SIGNUP_ALLOW_DISPOSABLE", "true")
    created = client.post("/admin/users", headers=_admin(), json={"email": DISPOSABLE_EMAIL})
    assert created.status_code == 201
    uid = created.json()["id"]

    monkeypatch.setenv("SIGNUP_ALLOW_DISPOSABLE", "false")
    again = client.post("/admin/users", headers=_admin(), json={"email": DISPOSABLE_EMAIL})
    assert again.status_code == 200, "an existing account must never be locked out by the block"
    assert again.json()["id"] == uid
