"""Calendar connection value object stored inside the identity-owned user document.

Feed URLs are credentials.  Only ``internal_connections`` includes them; every
user-facing representation goes through ``masked_connection``.

DB-30 adds a SECOND connection ``kind`` beside the original ICS feed: ``"google"``, an OAuth
connection holding the Google account's email (for display), the selected calendar ids
(default ``["primary"]``), and a reference to the encrypted refresh token — never the token
itself (see ``token_cipher.py``: the ciphertext is a separate field, ``google_refresh_token_enc``,
and it crosses ``masked_connection`` and ``internal_connections`` alike NEVER — only
``main.py``'s internal google-token edge reads it, decrypts it, and immediately discards the
plaintext after the refresh call). Every connection dict now carries ``kind`` (``"ics"`` is the
default for every row written before DB-30, so existing connections keep working unchanged).
"""
from __future__ import annotations

from typing import Optional
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import HTTPException, status

MAX_CALENDAR_CONNECTIONS = 10
DEFAULT_GOOGLE_CALENDAR_IDS = ["primary"]


def validate_bot_name(value: str) -> str:
    name = value.strip()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bot_name is required")
    if len(name) > 100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="bot_name too long")
    return name


def validate_ics_url(value: str) -> str:
    url = value.strip()
    if not url:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="ics_url is required")
    if len(url) > 2048:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="ics_url too long")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="ics_url must be an http(s) URL")
    if "/calendar/embed" in (parsed.path or "").lower():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=("that's the calendar's embed page, not its feed - in Google Calendar "
                    "open Settings -> Integrate calendar and copy the 'Secret address in "
                    "iCal format' (ends in .ics)"),
        )
    return url


def _legacy_id(user_id: int) -> str:
    return str(uuid5(NAMESPACE_URL, f"vexa:user:{user_id}:calendar:legacy"))


def connections_from_data(data: dict, user_id: int, *, include_deleted: bool = False) -> list[dict]:
    raw = data.get("calendar_connections")
    if isinstance(raw, list):
        connections = [dict(item) for item in raw if isinstance(item, dict) and item.get("id")]
    else:
        legacy_url = data.get("calendar_ics_url")
        connections = ([{
            "id": _legacy_id(user_id),
            "kind": "ics",
            "name": "Calendar",
            "ics_url": legacy_url,
            "auto_join": bool(data.get("calendar_auto_join", True)),
            "bot_name": data.get("calendar_bot_name") or "Vexa",
            "enabled": True,
        }] if legacy_url else [])
    return connections if include_deleted else [c for c in connections if not c.get("deleted")]


def new_connection(*, name: str, ics_url: str, auto_join: bool = True,
                   bot_name: str = "Vexa") -> dict:
    cleaned_name = name.strip()
    if not cleaned_name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name is required")
    if len(cleaned_name) > 100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name too long")
    return {
        "id": str(uuid4()),
        "kind": "ics",
        "name": cleaned_name,
        "ics_url": validate_ics_url(ics_url),
        "auto_join": bool(auto_join),
        "bot_name": validate_bot_name(bot_name),
        "enabled": True,
    }


def validate_google_calendar_ids(value: Optional[list]) -> list:
    ids = [str(v).strip() for v in (value or DEFAULT_GOOGLE_CALENDAR_IDS) if str(v).strip()]
    if not ids:
        ids = list(DEFAULT_GOOGLE_CALENDAR_IDS)
    if len(ids) > 25:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="at most 25 calendar ids per Google connection")
    return ids


def new_google_connection(*, id: Optional[str] = None, name: str, google_email: str,
                          refresh_token_enc: str, google_calendar_ids: Optional[list] = None,
                          auto_join: bool = True, bot_name: str = "Vexa") -> dict:
    """A ``kind: "google"`` connection. ``refresh_token_enc`` is the ALREADY-ENCRYPTED blob
    (``token_cipher.encrypt``) — this function never sees, and this module never stores, a
    plaintext refresh token. ``id``, when the caller already minted one to bind as
    ``token_cipher``'s associated data before encrypting, is used as-is; otherwise one is minted
    here (the connection's id is stable either way)."""
    cleaned_name = name.strip() or google_email
    if len(cleaned_name) > 100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name too long")
    email = (google_email or "").strip()
    if not email or "@" not in email:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="google_email must be a valid address")
    return {
        "id": id or str(uuid4()),
        "kind": "google",
        "name": cleaned_name,
        "google_email": email,
        "google_calendar_ids": validate_google_calendar_ids(google_calendar_ids),
        "google_refresh_token_enc": refresh_token_enc,
        "reconnect_needed": False,
        "auto_join": bool(auto_join),
        "bot_name": validate_bot_name(bot_name),
        "enabled": True,
    }


def store_connections(data: dict, connections: list[dict]) -> dict:
    """Persist the plural authority and mirror its first active row for old clients."""
    out = dict(data)
    out["calendar_connections"] = connections
    active = next((c for c in connections if not c.get("deleted") and c.get("ics_url")), None)
    if active:
        out["calendar_ics_url"] = active["ics_url"]
        out["calendar_auto_join"] = bool(active.get("auto_join", True))
    else:
        out.pop("calendar_ics_url", None)
        out.pop("calendar_auto_join", None)
    return out


def masked_connection(connection: dict) -> dict:
    kind = connection.get("kind") or "ics"
    base = {
        "id": connection["id"],
        "kind": kind,
        "name": connection.get("name") or "Calendar",
        "auto_join": bool(connection.get("auto_join", True)),
        "bot_name": connection.get("bot_name") or "Vexa",
        "enabled": bool(connection.get("enabled", True)),
    }
    if kind == "google":
        # The refresh token NEVER appears here — not even masked. The account email is not a
        # secret (it is what the user picked in the Google consent screen a moment ago); the
        # calendar ids are the user's own configuration. ``reconnect_needed`` surfaces a
        # revoked/expired grant instead of a silent sync failure (DB-30 acceptance).
        base.update({
            "google_email": connection.get("google_email"),
            "google_calendar_ids": connection.get("google_calendar_ids") or list(DEFAULT_GOOGLE_CALENDAR_IDS),
            "reconnect_needed": bool(connection.get("reconnect_needed", False)),
        })
        return base
    url = connection.get("ics_url") or ""
    host = urlparse(url).hostname or ""
    base.update({
        "ics_url_set": bool(url),
        "ics_url_masked": f"{host}/…{url[-4:]}" if url else None,
    })
    return base


def legacy_connection_id(connections: list[dict], user_id: int) -> Optional[str]:
    """Which connection owns the meeting rows stamped by the singular (pre-plural) feed.

    Those rows carry ``data.calendar_uid`` and no ``calendar_sources``, so they name no
    connection.  Exactly ONE connection may claim them, or every other calendar's sweep would
    read them as its own and cancel them: the connection synthesized from the legacy keys when
    one exists, otherwise the first connection in the list (the one the singular feed migrated
    into).  ``None`` when the user has no connections at all."""
    synthesized = _legacy_id(user_id)
    if any(connection.get("id") == synthesized for connection in connections):
        return synthesized
    return connections[0]["id"] if connections else None


def internal_connections(data: dict, user_id: int) -> list[dict]:
    """Flatten one user's connections for the secret-gated meeting-api edge.

    Three shapes cross the hop.  A LIVE connection carries its feed URL and syncs normally.  A
    DELETED one is a tombstone: no URL, and the sweep parses it as an empty feed so its managed
    rows retire.  A DISABLED one (``enabled: false``) is a tombstone too — a paused calendar must
    leave no meeting armed — and re-enabling re-imports on the next sweep.
    """
    connections = connections_from_data(data, user_id, include_deleted=True)
    legacy_id = legacy_connection_id(connections, user_id)
    out = []
    for connection in connections:
        entry = {
            "user_id": user_id,
            "calendar_id": connection["id"],
            "calendar_name": connection.get("name") or "Calendar",
            "bot_name": connection.get("bot_name") or "Vexa",
        }
        if connection["id"] == legacy_id:
            entry["legacy"] = True
        kind = connection.get("kind") or "ics"
        if kind == "google":
            entry["kind"] = "google"
        if connection.get("deleted"):
            out.append({**entry, "deleted": True})
        elif not connection.get("enabled", True):
            out.append({**entry, "deleted": False, "paused": True})
        elif kind == "google":
            # The refresh token crosses THIS hop NEVER — meeting-api asks for a fresh access
            # token over the internal google-token edge instead (main.py), so it never reads
            # identity's tables or the encrypted blob directly (P-book: the core owns its
            # contracts; a consumer is handed a capability, not a credential).
            out.append({
                **entry,
                "google_calendar_ids": connection.get("google_calendar_ids") or list(DEFAULT_GOOGLE_CALENDAR_IDS),
                "auto_join": bool(connection.get("auto_join", True)),
                "reconnect_needed": bool(connection.get("reconnect_needed", False)),
            })
        elif connection.get("ics_url"):
            out.append({
                **entry,
                "ics_url": connection["ics_url"],
                "auto_join": bool(connection.get("auto_join", True)),
            })
    return out


def set_reconnect_needed(connections: list[dict], calendar_id: str, needed: bool) -> list[dict]:
    """Flip a Google connection's ``reconnect_needed`` flag (the internal google-token edge calls
    this: ``invalid_grant`` sets it True, a subsequent successful refresh clears it back to
    False). A no-op list (returns ``connections`` unchanged) when the id names no live Google
    connection — the caller does not need to special-case "not found"."""
    out = []
    for connection in connections:
        if connection.get("id") == calendar_id and (connection.get("kind") or "ics") == "google" \
                and not connection.get("deleted"):
            connection = {**connection, "reconnect_needed": bool(needed)}
        out.append(connection)
    return out
