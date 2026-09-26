"""microsoft_oauth.py — DB-32: the Microsoft Graph Calendar OAuth flow, server-side, client secret
never leaving admin-api. Same shape as ``google_oauth.py``; see that module's docstring for the
rationale each piece below mirrors.

* ``build_authorize_url`` — the consent-screen URL, carrying a signed ``state``.
* ``sign_state`` / ``verify_state`` — CSRF protection for the flow, identical construction to
  ``google_oauth``'s (HMAC-signed, domain-separated by its own ``STATE_LABEL`` so this use can
  never be replayed against, or confused with, Google's).
* ``exchange_code`` / ``refresh_access_token`` / ``fetch_userinfo`` — the actual calls to
  Microsoft's identity platform (Azure AD v2 endpoint) and Microsoft Graph. Real network I/O;
  every test fakes these at the function boundary, never the network.

Tenant: Microsoft's v2 endpoint is per-tenant (``/{tenant}/oauth2/v2.0/...``). Vexa defaults to
``common`` — the multi-tenant + personal-account endpoint — so a self-host with no organizational
Azure AD tenant of its own still gets a working consent screen; an operator whose Azure AD tenant
requires it may pin a specific tenant id via ``MICROSOFT_CALENDAR_TENANT_ID``.

Scope: ``https://graph.microsoft.com/Calendars.Read`` (read-only calendar access) plus
``offline_access`` — WITHOUT ``offline_access`` Microsoft's v2 endpoint issues an access token
only, no refresh token, unlike Google which grants one whenever ``access_type=offline`` is asked
for. ``Calendars.Read`` alone is the minimum: no write, no ACL, no other Graph resource.
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

DEFAULT_TENANT = "common"

ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me"

# read-only calendar access + the scope that actually earns a refresh token — see module docstring
CALENDAR_SCOPE = "https://graph.microsoft.com/Calendars.Read offline_access"

STATE_LABEL = b"vexa-microsoft-calendar-oauth-state-v1"
STATE_TTL_S = 600  # 10 minutes — long enough for a consent screen, short enough to bound replay


def authorize_endpoint(tenant: str) -> str:
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"


def token_endpoint(tenant: str) -> str:
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"


class OAuthStateError(ValueError):
    """The state token failed signature, expiry, or ownership verification (never leaks which)."""


def _signing_key() -> bytes:
    secret = os.environ.get("INTERNAL_API_SECRET") or ""
    return hmac.new(secret.encode("utf-8"), STATE_LABEL, hashlib.sha256).digest()


def sign_state(user_id: int, *, nonce: Optional[str] = None, now: Optional[float] = None) -> str:
    """A single-use-capable, user-bound, short-TTL CSRF token — identical construction to
    ``google_oauth.sign_state``, domain-separated by this module's own ``STATE_LABEL``."""
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
    """Verify signature, expiry, and caller binding → the state's ``nonce``. Raises
    :class:`OAuthStateError` on ANY failure, with no distinction in the exception type between
    them (an attacker learns nothing about WHY a forged state failed)."""
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


def build_authorize_url(*, client_id: str, redirect_uri: str, state: str,
                        tenant: str = DEFAULT_TENANT) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "response_mode": "query",
        "scope": CALENDAR_SCOPE,
        "prompt": "consent",
        "state": state,
    }
    return f"{authorize_endpoint(tenant)}?{urlencode(params)}"


class MicrosoftOAuthError(RuntimeError):
    """Microsoft's token/Graph endpoint refused the request — carries a human-readable reason."""

    def __init__(self, reason: str, *, invalid_grant: bool = False):
        super().__init__(reason)
        self.reason = reason
        # invalid_grant is the Azure AD v2 endpoint's own error code for "this refresh token is
        # revoked/expired" — the one case that must become the connection's reconnect_needed
        # state, not a generic failure (same rule DB-30 set for Google).
        self.invalid_grant = invalid_grant


async def exchange_code(*, code: str, client_id: str, client_secret: str,
                        redirect_uri: str, tenant: str = DEFAULT_TENANT,
                        timeout_s: float = 10.0) -> dict:
    """The authorization-code → token exchange. Returns Microsoft's token response
    (``access_token``, ``refresh_token``?, ``expires_in``, ``scope``, ``token_type``). Raises
    :class:`MicrosoftOAuthError` on any non-2xx answer."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(token_endpoint(tenant), data={
            "code": code, "client_id": client_id, "client_secret": client_secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code",
            "scope": CALENDAR_SCOPE,
        })
    return _token_response_or_raise(resp)


async def refresh_access_token(*, refresh_token: str, client_id: str, client_secret: str,
                               tenant: str = DEFAULT_TENANT, timeout_s: float = 10.0) -> dict:
    """Trade a stored refresh token for a fresh access token. Raises :class:`MicrosoftOAuthError`
    with ``invalid_grant=True`` when Microsoft reports the grant is revoked or expired — the
    caller (``main.py``'s internal microsoft-token edge) turns that into the connection's
    reconnect_needed state rather than a bare failure."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(token_endpoint(tenant), data={
            "refresh_token": refresh_token, "client_id": client_id,
            "client_secret": client_secret, "grant_type": "refresh_token",
            "scope": CALENDAR_SCOPE,
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
    reason = f"Microsoft token endpoint answered HTTP {resp.status_code} ({error}: {description})" \
        if error else f"Microsoft token endpoint answered HTTP {resp.status_code}"
    raise MicrosoftOAuthError(reason, invalid_grant=(error == "invalid_grant"))


async def fetch_userinfo(*, access_token: str, timeout_s: float = 10.0) -> dict:
    """The Microsoft account's Graph profile (used for the connected email — ``mail``, falling
    back to ``userPrincipalName`` when ``mail`` is null, which Graph does for some tenants/
    account types). Raises :class:`MicrosoftOAuthError` on any non-2xx answer."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.get(ME_ENDPOINT,
                                headers={"Authorization": f"Bearer {access_token}"})
    if resp.status_code != 200:
        raise MicrosoftOAuthError(f"Microsoft Graph /me answered HTTP {resp.status_code}")
    return resp.json()
