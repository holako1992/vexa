"""google_oauth.py — DB-30: the Google Calendar OAuth flow, server-side, client secret never
leaving admin-api.

Two request-time concerns and one I/O concern live here:

* ``build_authorize_url`` — the consent-screen URL, carrying a signed ``state``.
* ``sign_state`` / ``verify_state`` — CSRF protection for the flow. The state is a compact,
  self-contained, HMAC-signed token (signed with ``INTERNAL_API_SECRET``, domain-separated by the
  ``STATE_LABEL`` HMAC context so this use can never be replayed against, or confused with, any
  other consumer of that same secret): it carries the caller's user id, a random nonce, and an
  expiry, so admin-api verifies it with NO server-side session store. Single-use is enforced by
  the caller (``main.py``'s exchange route) recording the nonce on the CALLING user's own row —
  the one piece state alone cannot prove, because "have I seen this nonce before" is exactly the
  question a stateless token cannot answer of itself.
* ``exchange_code`` / ``refresh_access_token`` / ``fetch_userinfo`` — the actual calls to Google's
  OAuth endpoints. Real network I/O; every calendar_sync/adapters.py-style test fakes these at the
  function boundary, never the network.

Scope: ``https://www.googleapis.com/auth/calendar.readonly`` — the READ-ONLY calendar scope,
covering both the calendar list (``calendarList.list`` — how a future "pick a calendar" step would
enumerate a user's calendars beyond ``primary``) and event reads. The narrower
``calendar.events.readonly`` was considered and rejected: it does not grant ``calendarList.list``,
and DB-30 already stores a ``google_calendar_ids`` list (default ``["primary"]``) that a later
UI needs to populate from the user's actual calendars — a scope that cannot list calendars would
block that without a second consent round-trip. ``calendar.readonly`` is still the minimum: it
grants no write, no ACL, no free/busy-of-other-people surface.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Optional
from urllib.parse import urlencode

AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo"

# read-only calendar scope — see module docstring for why not the narrower events.readonly
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"

STATE_LABEL = b"vexa-google-calendar-oauth-state-v1"
STATE_TTL_S = 600  # 10 minutes — long enough for a consent screen, short enough to bound replay


class OAuthStateError(ValueError):
    """The state token failed signature, expiry, or ownership verification (never leaks which)."""


def _signing_key() -> bytes:
    secret = os.environ.get("INTERNAL_API_SECRET") or ""
    return hmac.new(secret.encode("utf-8"), STATE_LABEL, hashlib.sha256).digest()


def sign_state(user_id: int, *, nonce: Optional[str] = None, now: Optional[float] = None) -> str:
    """A single-use-capable, user-bound, short-TTL CSRF token. ``nonce`` is injectable for tests;
    production callers always let it default to a fresh random value."""
    import secrets

    payload = {
        "uid": int(user_id),
        "nonce": nonce or secrets.token_hex(16),
        "iat": now if now is not None else time.time(),
    }
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).rstrip(b"=")
    sig = hmac.new(_signing_key(), body, hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=")
    return f"{body.decode()}.{sig_b64.decode()}"


def verify_state(token: str, *, expected_user_id: int, now: Optional[float] = None) -> str:
    """Verify signature, expiry, and caller binding → the state's ``nonce`` (the caller then
    checks/records that nonce for single-use). Raises :class:`OAuthStateError` on ANY failure —
    bad signature, expired, malformed, or minted for a different user — with no distinction in the
    exception type between them (an attacker learns nothing about WHY a forged state failed)."""
    try:
        body_s, sig_s = token.split(".", 1)
        body = body_s.encode()
        sig = base64.urlsafe_b64decode(sig_s + "=" * (-len(sig_s) % 4))
    except (ValueError, Exception) as e:  # noqa: BLE001 — any parse failure is the same refusal
        raise OAuthStateError("malformed state token") from e
    expected_sig = hmac.new(_signing_key(), body, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected_sig):
        raise OAuthStateError("state token signature does not verify")
    try:
        payload = json.loads(base64.urlsafe_b64decode(body + b"=" * (-len(body) % 4)))
    except Exception as e:  # noqa: BLE001
        raise OAuthStateError("state token payload is not valid JSON") from e
    if not isinstance(payload, dict) or "uid" not in payload or "nonce" not in payload or "iat" not in payload:
        raise OAuthStateError("state token payload is missing required fields")
    moment = now if now is not None else time.time()
    if moment - float(payload["iat"]) > STATE_TTL_S:
        raise OAuthStateError("state token has expired")
    if int(payload["uid"]) != int(expected_user_id):
        raise OAuthStateError("state token was not minted for this caller")
    return str(payload["nonce"])


def build_authorize_url(*, client_id: str, redirect_uri: str, state: str) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": CALENDAR_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"{AUTHORIZE_ENDPOINT}?{urlencode(params)}"


class GoogleOAuthError(RuntimeError):
    """Google's token/userinfo endpoint refused the request — carries a human-readable reason."""

    def __init__(self, reason: str, *, invalid_grant: bool = False):
        super().__init__(reason)
        self.reason = reason
        # invalid_grant is Google's own error code for "this refresh token is revoked/expired" —
        # the one case that must become the connection's reconnect_needed state, not a generic
        # failure (DB-30 acceptance: revoked/expired sets a VISIBLE state, never a silent failure).
        self.invalid_grant = invalid_grant


async def exchange_code(*, code: str, client_id: str, client_secret: str,
                        redirect_uri: str, timeout_s: float = 10.0) -> dict:
    """The authorization-code → token exchange. Returns Google's token response
    (``access_token``, ``refresh_token``?, ``expires_in``, ``scope``, ``token_type``). Raises
    :class:`GoogleOAuthError` on any non-2xx answer."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(TOKEN_ENDPOINT, data={
            "code": code, "client_id": client_id, "client_secret": client_secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code",
        })
    return _token_response_or_raise(resp)


async def refresh_access_token(*, refresh_token: str, client_id: str, client_secret: str,
                               timeout_s: float = 10.0) -> dict:
    """Trade a stored refresh token for a fresh access token. Raises :class:`GoogleOAuthError`
    with ``invalid_grant=True`` when Google reports the grant is revoked or expired — the caller
    (``main.py``'s internal google-token edge) turns that into the connection's reconnect_needed
    state rather than a bare failure."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(TOKEN_ENDPOINT, data={
            "refresh_token": refresh_token, "client_id": client_id,
            "client_secret": client_secret, "grant_type": "refresh_token",
        })
    return _token_response_or_raise(resp)


def _token_response_or_raise(resp) -> dict:
    if resp.status_code == 200:
        return resp.json()
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001
        body = {}
    error = str(body.get("error") or "")
    description = str(body.get("error_description") or "")
    reason = f"Google token endpoint answered HTTP {resp.status_code} ({error}: {description})" \
        if error else f"Google token endpoint answered HTTP {resp.status_code}"
    raise GoogleOAuthError(reason, invalid_grant=(error == "invalid_grant"))


async def fetch_userinfo(*, access_token: str, timeout_s: float = 10.0) -> dict:
    """The Google account's profile (used for ``email``). Raises :class:`GoogleOAuthError` on any
    non-2xx answer."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.get(USERINFO_ENDPOINT,
                                headers={"Authorization": f"Bearer {access_token}"})
    if resp.status_code != 200:
        raise GoogleOAuthError(f"Google userinfo endpoint answered HTTP {resp.status_code}")
    return resp.json()
