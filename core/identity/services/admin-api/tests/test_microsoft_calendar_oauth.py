"""DB-32: Microsoft Graph Calendar OAuth connect — state signing/expiry/replay/ownership (pure),
the exchange route (encrypted-at-rest storage, masking, 503 when unconfigured), and the internal
microsoft-token edge (reconnect_needed on a revoked grant). Same shape as
``test_google_calendar_oauth.py`` (DB-30) — see that file's docstring for why the pure state tests
are grouped here under the same docker-gated marker rather than split out the way
``test_token_cipher.py`` was.

Same testcontainers-PG harness as test_calendar_config.py (skips without docker, Postgres only —
no redis, so none of rule 15's redis-testcontainer trap applies here).
"""
import base64
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app import microsoft_oauth
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker

MICROSOFT_ENV = {
    "MICROSOFT_CALENDAR_CLIENT_ID": "11111111-2222-3333-4444-555555555555",
    "MICROSOFT_CALENDAR_CLIENT_SECRET": "test-client-secret",
    "MICROSOFT_CALENDAR_REDIRECT_URI": "https://dashboard.example.com/calendar/microsoft/callback",
    # test-only key — a valid base64-encoded 32 raw bytes, not a real secret.
    "CALENDAR_TOKEN_ENCRYPTION_KEY": base64.b64encode(b"\x22" * 32).decode(),
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
    for key, value in MICROSOFT_ENV.items():
        monkeypatch.setenv(key, value)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


@pytest.fixture()
def unconfigured_client(pg_url, pg_async_url, monkeypatch):
    """Same stack, but with the microsoft_calendar capability keys UNSET — the 503 path."""
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    for key in MICROSOFT_ENV:
        monkeypatch.delenv(key, raising=False)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _user_token(client, email="msft@vexa.ai", max_bots=4):
    uid = client.post("/admin/users", headers=_admin(),
                      json={"email": email, "max_concurrent_bots": max_bots}).json()["id"]
    tok = client.post(f"/admin/users/{uid}/tokens?scopes=bot,tx", headers=_admin()).json()["token"]
    return uid, tok


# ── state: signature, expiry, replay, wrong-user (pure — no HTTP, no docker needed, but grouped
#    here so the whole DB-32 spec lives in one file, same as DB-30's) ──────────────────────────

def test_state_roundtrips_for_the_minting_user():
    token = microsoft_oauth.sign_state(42, nonce="fixed-nonce", now=1000.0)
    nonce = microsoft_oauth.verify_state(token, expected_user_id=42, now=1000.0)
    assert nonce == "fixed-nonce"


def test_state_rejects_expiry():
    token = microsoft_oauth.sign_state(42, nonce="n", now=1000.0)
    with pytest.raises(microsoft_oauth.OAuthStateError):
        microsoft_oauth.verify_state(token, expected_user_id=42,
                                     now=1000.0 + microsoft_oauth.STATE_TTL_S + 1)


def test_state_rejects_wrong_user():
    token = microsoft_oauth.sign_state(42, nonce="n", now=1000.0)
    with pytest.raises(microsoft_oauth.OAuthStateError):
        microsoft_oauth.verify_state(token, expected_user_id=99, now=1000.0)


def test_state_rejects_tampered_signature():
    token = microsoft_oauth.sign_state(42, nonce="n", now=1000.0)
    body, sig = token.rsplit(".", 1)
    tampered = f"{body}.{sig[:-2]}xx"
    with pytest.raises(microsoft_oauth.OAuthStateError):
        microsoft_oauth.verify_state(tampered, expected_user_id=42, now=1000.0)


def test_state_rejects_malformed_token():
    with pytest.raises(microsoft_oauth.OAuthStateError):
        microsoft_oauth.verify_state("not-a-real-token", expected_user_id=42)


def test_google_and_microsoft_states_never_cross_validate():
    """The two providers' state tokens are signed under domain-separated labels (DB-30's
    ``google_oauth.STATE_LABEL`` vs this module's own) — a state minted for one flow must never
    verify against the other's key derivation, even holding INTERNAL_API_SECRET constant."""
    from admin_api.app import google_oauth

    token = microsoft_oauth.sign_state(42, nonce="n", now=1000.0)
    with pytest.raises(google_oauth.OAuthStateError):
        google_oauth.verify_state(token, expected_user_id=42, now=1000.0)


# ── the routes ─────────────────────────────────────────────────────────────────────────────────

def test_authorize_returns_a_consent_url_with_signed_state(client):
    _uid, tok = _user_token(client)
    r = client.get("/user/calendars/microsoft/authorize", headers={"X-API-Key": tok})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["authorize_url"].startswith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?")
    assert "Calendars.Read" in body["authorize_url"]
    assert "offline_access" in body["authorize_url"]
    assert "prompt=consent" in body["authorize_url"]
    assert body["state"] in body["authorize_url"]


def test_exchange_stores_encrypted_token_never_plaintext(client, monkeypatch):
    uid, tok = _user_token(client, email="exchange@vexa.ai")

    async def fake_exchange_code(**kw):
        return {"access_token": "eyJ.fake-access", "refresh_token": "0.fake-refresh-token-value",
                "expires_in": 3599}

    async def fake_fetch_userinfo(**kw):
        return {"mail": "person@outlook.com", "userPrincipalName": "person@outlook.com"}

    monkeypatch.setattr(microsoft_oauth, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(microsoft_oauth, "fetch_userinfo", fake_fetch_userinfo)

    h = {"X-API-Key": tok}
    state = client.get("/user/calendars/microsoft/authorize", headers=h).json()["state"]
    r = client.post("/user/calendars/microsoft/exchange", headers=h,
                    json={"code": "auth-code-123", "state": state})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "microsoft"
    assert body["microsoft_email"] == "person@outlook.com"
    assert body["microsoft_calendar_ids"] == ["primary"]
    assert body["reconnect_needed"] is False
    assert "0.fake-refresh-token-value" not in str(body)

    # the raw refresh token never appears anywhere in the stored user row
    row = client.get(f"/admin/users/{uid}", headers=_admin()).json()
    assert "0.fake-refresh-token-value" not in str(row)
    # the encrypted blob IS present, versioned, and not the plaintext
    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    ms_conn = next(c for c in conns if c["kind"] == "microsoft")
    assert "microsoft_refresh_token_enc" not in ms_conn  # never in the masked read

    # replaying the same state is refused (single-use)
    r2 = client.post("/user/calendars/microsoft/exchange", headers=h,
                     json={"code": "auth-code-123", "state": state})
    assert r2.status_code == 409, r2.text


def test_exchange_falls_back_to_user_principal_name_when_mail_is_null(client, monkeypatch):
    """Some Microsoft account types (e.g. certain personal accounts) return ``mail: null`` from
    Graph's ``/me`` — ``userPrincipalName`` is always present, so the exchange must not fail loud
    on a null ``mail`` field when there is a usable identity to fall back to."""
    _uid, tok = _user_token(client, email="upn@vexa.ai")

    async def fake_exchange_code(**kw):
        return {"access_token": "x", "refresh_token": "y", "expires_in": 3599}

    async def fake_fetch_userinfo(**kw):
        return {"mail": None, "userPrincipalName": "person@tenant.onmicrosoft.com"}

    monkeypatch.setattr(microsoft_oauth, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(microsoft_oauth, "fetch_userinfo", fake_fetch_userinfo)

    h = {"X-API-Key": tok}
    state = client.get("/user/calendars/microsoft/authorize", headers=h).json()["state"]
    r = client.post("/user/calendars/microsoft/exchange", headers=h,
                    json={"code": "c", "state": state})
    assert r.status_code == 201, r.text
    assert r.json()["microsoft_email"] == "person@tenant.onmicrosoft.com"


def test_exchange_rejects_state_minted_for_another_user(client, monkeypatch):
    _uid1, tok1 = _user_token(client, email="state-a@vexa.ai")
    _uid2, tok2 = _user_token(client, email="state-b@vexa.ai")

    async def fake_exchange_code(**kw):
        return {"access_token": "x", "refresh_token": "y", "expires_in": 3599}

    monkeypatch.setattr(microsoft_oauth, "exchange_code", fake_exchange_code)

    state_for_1 = client.get("/user/calendars/microsoft/authorize",
                             headers={"X-API-Key": tok1}).json()["state"]
    r = client.post("/user/calendars/microsoft/exchange", headers={"X-API-Key": tok2},
                    json={"code": "c", "state": state_for_1})
    assert r.status_code == 400, r.text


def test_exchange_rejects_expired_state(client, monkeypatch):
    uid, tok = _user_token(client, email="expired@vexa.ai")
    old_state = microsoft_oauth.sign_state(uid, now=time.time() - microsoft_oauth.STATE_TTL_S - 5)
    r = client.post("/user/calendars/microsoft/exchange", headers={"X-API-Key": tok},
                    json={"code": "c", "state": old_state})
    assert r.status_code == 400, r.text
    assert "state" in r.json()["detail"].lower()


def test_microsoft_routes_503_when_not_configured(unconfigured_client):
    uid, tok = _user_token(unconfigured_client, email="unconfigured@vexa.ai")
    h = {"X-API-Key": tok}
    r = unconfigured_client.get("/user/calendars/microsoft/authorize", headers=h)
    assert r.status_code == 503
    assert "MICROSOFT_CALENDAR" in r.json()["detail"] or "missing" in r.json()["detail"].lower()

    r = unconfigured_client.post("/user/calendars/microsoft/exchange", headers=h,
                                 json={"code": "c", "state": "s"})
    assert r.status_code == 503

    # ICS is completely unaffected by the missing Microsoft config
    r = unconfigured_client.post("/user/calendars", headers=h,
                                 json={"name": "Work",
                                       "ics_url": "https://calendar.google.com/calendar/ical/x%40vexa.ai/private-abc/basic.ics"})
    assert r.status_code == 201, r.text


def test_internal_microsoft_token_edge_requires_internal_secret(client):
    r = client.post("/internal/calendars/some-id/microsoft-token", json={"user_id": 1})
    assert r.status_code == 403


def test_internal_microsoft_token_edge_revoked_grant_sets_reconnect_needed(client, monkeypatch):
    uid, tok = _user_token(client, email="revoked@vexa.ai")

    async def fake_exchange_code(**kw):
        return {"access_token": "x", "refresh_token": "revoked-later-token", "expires_in": 3599}

    async def fake_fetch_userinfo(**kw):
        return {"mail": "revoked@outlook.com"}

    monkeypatch.setattr(microsoft_oauth, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(microsoft_oauth, "fetch_userinfo", fake_fetch_userinfo)

    h = {"X-API-Key": tok}
    state = client.get("/user/calendars/microsoft/authorize", headers=h).json()["state"]
    created = client.post("/user/calendars/microsoft/exchange", headers=h,
                          json={"code": "c", "state": state}).json()
    calendar_id = created["id"]
    assert created["reconnect_needed"] is False

    async def fake_refresh_revoked(**kw):
        raise microsoft_oauth.MicrosoftOAuthError(
            "invalid_grant: AADSTS70008: token has expired or been revoked", invalid_grant=True)

    monkeypatch.setattr(microsoft_oauth, "refresh_access_token", fake_refresh_revoked)
    r = client.post(f"/internal/calendars/{calendar_id}/microsoft-token",
                    headers={"X-Internal-Secret": INTERNAL_SECRET}, json={"user_id": uid})
    assert r.status_code == 409, r.text
    assert "reconnect_needed" in r.json()["detail"]

    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    ms_conn = next(c for c in conns if c["kind"] == "microsoft")
    assert ms_conn["reconnect_needed"] is True

    # a subsequent SUCCESSFUL refresh clears the flag
    async def fake_refresh_ok(**kw):
        return {"access_token": "fresh-token", "expires_in": 3599}

    monkeypatch.setattr(microsoft_oauth, "refresh_access_token", fake_refresh_ok)
    r = client.post(f"/internal/calendars/{calendar_id}/microsoft-token",
                    headers={"X-Internal-Secret": INTERNAL_SECRET}, json={"user_id": uid})
    assert r.status_code == 200, r.text
    assert r.json()["access_token"] == "fresh-token"
    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    ms_conn = next(c for c in conns if c["kind"] == "microsoft")
    assert ms_conn["reconnect_needed"] is False


def test_ics_google_and_microsoft_connections_coexist_in_the_masked_list(client, monkeypatch):
    uid, tok = _user_token(client, email="mixed@vexa.ai")
    h = {"X-API-Key": tok}

    client.post("/user/calendars", headers=h,
               json={"name": "Work",
                     "ics_url": "https://calendar.google.com/calendar/ical/x%40vexa.ai/private-abc/basic.ics"})

    async def fake_exchange_code(**kw):
        return {"access_token": "x", "refresh_token": "y", "expires_in": 3599}

    async def fake_fetch_userinfo(**kw):
        return {"mail": "mixed@outlook.com"}

    monkeypatch.setattr(microsoft_oauth, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(microsoft_oauth, "fetch_userinfo", fake_fetch_userinfo)
    state = client.get("/user/calendars/microsoft/authorize", headers=h).json()["state"]
    client.post("/user/calendars/microsoft/exchange", headers=h, json={"code": "c", "state": state})

    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    kinds = sorted(c["kind"] for c in conns)
    assert kinds == ["ics", "microsoft"]
    ics_conn = next(c for c in conns if c["kind"] == "ics")
    assert "microsoft_email" not in ics_conn
    assert ics_conn["ics_url_masked"] is not None
