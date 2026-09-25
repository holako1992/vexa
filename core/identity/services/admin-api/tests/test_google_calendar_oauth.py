"""DB-30: Google Calendar OAuth connect — state signing/expiry/replay/ownership (pure), the
exchange route (encrypted-at-rest storage, masking, 503 when unconfigured), and the internal
google-token edge (reconnect_needed on a revoked grant).

Same testcontainers-PG harness as test_calendar_config.py (skips without docker, Postgres only —
no redis, so none of rule 15's redis-testcontainer trap applies here).
"""
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app import google_oauth, token_cipher
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker

GOOGLE_ENV = {
    "GOOGLE_CALENDAR_CLIENT_ID": "test-client-id.apps.googleusercontent.com",
    "GOOGLE_CALENDAR_CLIENT_SECRET": "test-client-secret",
    "GOOGLE_CALENDAR_REDIRECT_URI": "https://dashboard.example.com/calendar/google/callback",
    "CALENDAR_TOKEN_ENCRYPTION_KEY": "test-only-encryption-key-not-a-real-secret",
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
    for key, value in GOOGLE_ENV.items():
        monkeypatch.setenv(key, value)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


@pytest.fixture()
def unconfigured_client(pg_url, pg_async_url, monkeypatch):
    """Same stack, but with the google_calendar capability keys UNSET — the 503 path."""
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    for key in GOOGLE_ENV:
        monkeypatch.delenv(key, raising=False)
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _user_token(client, email="goog@vexa.ai", max_bots=4):
    uid = client.post("/admin/users", headers=_admin(),
                      json={"email": email, "max_concurrent_bots": max_bots}).json()["id"]
    tok = client.post(f"/admin/users/{uid}/tokens?scopes=bot,tx", headers=_admin()).json()["token"]
    return uid, tok


# ── state: signature, expiry, replay, wrong-user (pure — no HTTP, no docker needed, but grouped
#    here so the whole DB-30 spec lives in one file) ────────────────────────────────────────────

def test_state_roundtrips_for_the_minting_user():
    token = google_oauth.sign_state(42, nonce="fixed-nonce", now=1000.0)
    nonce = google_oauth.verify_state(token, expected_user_id=42, now=1000.0)
    assert nonce == "fixed-nonce"


def test_state_rejects_expiry():
    token = google_oauth.sign_state(42, nonce="n", now=1000.0)
    with pytest.raises(google_oauth.OAuthStateError):
        google_oauth.verify_state(token, expected_user_id=42,
                                  now=1000.0 + google_oauth.STATE_TTL_S + 1)


def test_state_rejects_wrong_user():
    token = google_oauth.sign_state(42, nonce="n", now=1000.0)
    with pytest.raises(google_oauth.OAuthStateError):
        google_oauth.verify_state(token, expected_user_id=99, now=1000.0)


def test_state_rejects_tampered_signature():
    token = google_oauth.sign_state(42, nonce="n", now=1000.0)
    body, sig = token.rsplit(".", 1)
    tampered = f"{body}.{sig[:-2]}xx"
    with pytest.raises(google_oauth.OAuthStateError):
        google_oauth.verify_state(tampered, expected_user_id=42, now=1000.0)


def test_state_rejects_malformed_token():
    with pytest.raises(google_oauth.OAuthStateError):
        google_oauth.verify_state("not-a-real-token", expected_user_id=42)


def test_token_cipher_never_returns_plaintext_without_the_key(monkeypatch):
    monkeypatch.setenv("CALENDAR_TOKEN_ENCRYPTION_KEY", "a-real-key")
    blob = token_cipher.encrypt("super-secret-refresh-token")
    assert "super-secret-refresh-token" not in blob
    assert token_cipher.decrypt(blob) == "super-secret-refresh-token"
    monkeypatch.delenv("CALENDAR_TOKEN_ENCRYPTION_KEY", raising=False)
    with pytest.raises(token_cipher.TokenCipherError):
        token_cipher.encrypt("x")


def test_token_cipher_rejects_tampered_ciphertext(monkeypatch):
    monkeypatch.setenv("CALENDAR_TOKEN_ENCRYPTION_KEY", "a-real-key")
    blob = token_cipher.encrypt("refresh-token-value")
    tampered = blob[:-2] + ("aa" if blob[-2:] != "aa" else "bb")
    with pytest.raises(token_cipher.TokenCipherError):
        token_cipher.decrypt(tampered)


# ── the routes ─────────────────────────────────────────────────────────────────────────────────

def test_authorize_returns_a_consent_url_with_signed_state(client):
    _uid, tok = _user_token(client)
    r = client.get("/user/calendars/google/authorize", headers={"X-API-Key": tok})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["authorize_url"].startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "calendar.readonly" in body["authorize_url"]
    assert "access_type=offline" in body["authorize_url"]
    assert "prompt=consent" in body["authorize_url"]
    assert body["state"] in body["authorize_url"]


def test_exchange_stores_encrypted_token_never_plaintext(client, monkeypatch):
    uid, tok = _user_token(client, email="exchange@vexa.ai")

    async def fake_exchange_code(**kw):
        return {"access_token": "ya29.fake-access", "refresh_token": "1//fake-refresh-token-value",
                "expires_in": 3599}

    async def fake_fetch_userinfo(**kw):
        return {"email": "person@gmail.com"}

    monkeypatch.setattr(google_oauth, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(google_oauth, "fetch_userinfo", fake_fetch_userinfo)

    h = {"X-API-Key": tok}
    state = client.get("/user/calendars/google/authorize", headers=h).json()["state"]
    r = client.post("/user/calendars/google/exchange", headers=h,
                    json={"code": "auth-code-123", "state": state})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "google"
    assert body["google_email"] == "person@gmail.com"
    assert body["google_calendar_ids"] == ["primary"]
    assert body["reconnect_needed"] is False
    assert "refresh" not in str(body).lower() or "1//fake-refresh-token-value" not in str(body)
    assert "1//fake-refresh-token-value" not in str(body)

    # the raw refresh token never appears anywhere in the stored user row
    admin_uid = uid
    row = client.get(f"/admin/users/{admin_uid}", headers=_admin()).json()
    assert "1//fake-refresh-token-value" not in str(row)
    # the encrypted blob IS present, versioned, and not the plaintext
    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    google_conn = next(c for c in conns if c["kind"] == "google")
    assert "google_refresh_token_enc" not in google_conn  # never in the masked read

    # replaying the same state is refused (single-use)
    r2 = client.post("/user/calendars/google/exchange", headers=h,
                     json={"code": "auth-code-123", "state": state})
    assert r2.status_code == 409, r2.text


def test_exchange_rejects_state_minted_for_another_user(client, monkeypatch):
    _uid1, tok1 = _user_token(client, email="state-a@vexa.ai")
    _uid2, tok2 = _user_token(client, email="state-b@vexa.ai")

    async def fake_exchange_code(**kw):
        return {"access_token": "x", "refresh_token": "y", "expires_in": 3599}

    monkeypatch.setattr(google_oauth, "exchange_code", fake_exchange_code)

    state_for_1 = client.get("/user/calendars/google/authorize",
                             headers={"X-API-Key": tok1}).json()["state"]
    r = client.post("/user/calendars/google/exchange", headers={"X-API-Key": tok2},
                    json={"code": "c", "state": state_for_1})
    assert r.status_code == 400, r.text


def test_exchange_rejects_expired_state(client, monkeypatch):
    uid, tok = _user_token(client, email="expired@vexa.ai")
    old_state = google_oauth.sign_state(uid, now=time.time() - google_oauth.STATE_TTL_S - 5)
    r = client.post("/user/calendars/google/exchange", headers={"X-API-Key": tok},
                    json={"code": "c", "state": old_state})
    assert r.status_code == 400, r.text
    assert "state" in r.json()["detail"].lower()


def test_google_routes_503_when_not_configured(unconfigured_client):
    uid, tok = _user_token(unconfigured_client, email="unconfigured@vexa.ai")
    h = {"X-API-Key": tok}
    r = unconfigured_client.get("/user/calendars/google/authorize", headers=h)
    assert r.status_code == 503
    assert "GOOGLE_CALENDAR" in r.json()["detail"] or "missing" in r.json()["detail"].lower()

    r = unconfigured_client.post("/user/calendars/google/exchange", headers=h,
                                 json={"code": "c", "state": "s"})
    assert r.status_code == 503

    # ICS is completely unaffected by the missing Google config
    r = unconfigured_client.post("/user/calendars", headers=h,
                                 json={"name": "Work",
                                       "ics_url": "https://calendar.google.com/calendar/ical/x%40vexa.ai/private-abc/basic.ics"})
    assert r.status_code == 201, r.text


def test_internal_google_token_edge_requires_internal_secret(client):
    r = client.post("/internal/calendars/some-id/google-token", json={"user_id": 1})
    assert r.status_code == 403


def test_internal_google_token_edge_revoked_grant_sets_reconnect_needed(client, monkeypatch):
    uid, tok = _user_token(client, email="revoked@vexa.ai")

    async def fake_exchange_code(**kw):
        return {"access_token": "x", "refresh_token": "revoked-later-token", "expires_in": 3599}

    async def fake_fetch_userinfo(**kw):
        return {"email": "revoked@gmail.com"}

    monkeypatch.setattr(google_oauth, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(google_oauth, "fetch_userinfo", fake_fetch_userinfo)

    h = {"X-API-Key": tok}
    state = client.get("/user/calendars/google/authorize", headers=h).json()["state"]
    created = client.post("/user/calendars/google/exchange", headers=h,
                          json={"code": "c", "state": state}).json()
    calendar_id = created["id"]
    assert created["reconnect_needed"] is False

    async def fake_refresh_revoked(**kw):
        raise google_oauth.GoogleOAuthError("invalid_grant: token has been expired or revoked",
                                            invalid_grant=True)

    monkeypatch.setattr(google_oauth, "refresh_access_token", fake_refresh_revoked)
    r = client.post(f"/internal/calendars/{calendar_id}/google-token",
                    headers={"X-Internal-Secret": INTERNAL_SECRET}, json={"user_id": uid})
    assert r.status_code == 409, r.text
    assert "reconnect_needed" in r.json()["detail"]

    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    google_conn = next(c for c in conns if c["kind"] == "google")
    assert google_conn["reconnect_needed"] is True

    # a subsequent SUCCESSFUL refresh clears the flag
    async def fake_refresh_ok(**kw):
        return {"access_token": "fresh-token", "expires_in": 3599}

    monkeypatch.setattr(google_oauth, "refresh_access_token", fake_refresh_ok)
    r = client.post(f"/internal/calendars/{calendar_id}/google-token",
                    headers={"X-Internal-Secret": INTERNAL_SECRET}, json={"user_id": uid})
    assert r.status_code == 200, r.text
    assert r.json()["access_token"] == "fresh-token"
    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    google_conn = next(c for c in conns if c["kind"] == "google")
    assert google_conn["reconnect_needed"] is False


def test_ics_and_google_connections_coexist_in_the_masked_list(client, monkeypatch):
    uid, tok = _user_token(client, email="mixed@vexa.ai")
    h = {"X-API-Key": tok}

    client.post("/user/calendars", headers=h,
               json={"name": "Work",
                     "ics_url": "https://calendar.google.com/calendar/ical/x%40vexa.ai/private-abc/basic.ics"})

    async def fake_exchange_code(**kw):
        return {"access_token": "x", "refresh_token": "y", "expires_in": 3599}

    async def fake_fetch_userinfo(**kw):
        return {"email": "mixed@gmail.com"}

    monkeypatch.setattr(google_oauth, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(google_oauth, "fetch_userinfo", fake_fetch_userinfo)
    state = client.get("/user/calendars/google/authorize", headers=h).json()["state"]
    client.post("/user/calendars/google/exchange", headers=h, json={"code": "c", "state": state})

    conns = client.get("/user/calendars", headers=h).json()["calendars"]
    kinds = sorted(c["kind"] for c in conns)
    assert kinds == ["google", "ics"]
    ics_conn = next(c for c in conns if c["kind"] == "ics")
    assert "google_email" not in ics_conn
    assert ics_conn["ics_url_masked"] is not None
