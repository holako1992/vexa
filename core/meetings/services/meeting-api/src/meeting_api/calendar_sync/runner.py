"""One user's fetch→parse→sync→stamp pass — shared by the periodic sweep AND the sync-now edge.

The terminal's "Connect your calendar" panel needs IMMEDIATE feedback (paste → result), so the
same pass the background loop runs every ``CALENDAR_SYNC_INTERVAL_S`` is also callable on demand
for a single user. Both callers get the identical stamp shape that lands in redis
``cal:sync:{user_id}``: ``{last_sync, last_error, counts?}`` — the panel renders it as-is.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from .service import DEFAULT_HORIZON_DAYS, DEFAULT_LOOKBACK_S


def active_configs(configs: Optional[list], user_id: int,
                   calendar_id: Optional[str] = None) -> list[dict]:
    """This user's LIVE calendar connections — a TOMBSTONE is never one.

    A deleted connection still gets synced by the BACKGROUND sweep (an empty feed, so ``sync_user``
    strips its sources and retires the rows only it managed), but it is not something the user can
    sync on demand and it is not part of any roster they may read back: they removed it. Measured
    live 2026-08-17 — a user whose only connections were deleted got ``200`` from
    ``POST /user/calendar/sync`` plus a ``calendars[]`` array naming every one of them, where the
    documented answer is ``404`` (no active feed) and the roster is not theirs to see.

    A PAUSED connection is NOT a tombstone: the user still has it, the panel still lists it, and
    syncing it is how a pause takes effect. Only ``deleted`` is excluded.
    """
    return [
        cfg for cfg in configs or []
        if cfg.get("user_id") == user_id
        and not cfg.get("deleted")
        and (calendar_id is None or cfg.get("calendar_id") == calendar_id)
    ]


async def run_user_sync(
    store: Any,
    cfg: dict,
    *,
    publish: Optional[Callable[[int, dict], Awaitable[None]]] = None,
    now: Optional[datetime] = None,
    rows: Optional[list] = None,
    client: Any = None,
    admin_api_url: Optional[str] = None,
    internal_secret: Optional[str] = None,
) -> dict:
    """Run one full sync for ``cfg`` → the status stamp. Two config shapes, same downstream path:
    an ICS ``cfg = {user_id, ics_url, auto_join, ...}`` (``kind`` absent or ``"ics"``) or a Google
    ``cfg = {user_id, kind: "google", google_calendar_ids, auto_join, ...}`` (DB-30). Both resolve
    to the identical ``{"events": [...], "cancelled_uids": [...]}`` shape before ``sync_user`` ever
    sees them, so the two providers produce identical planned-meeting rows for an equivalent event.

    Never raises: every failure mode becomes the stamp's ``last_error`` (fail loud to the USER,
    not to the sweep) — including a revoked/expired Google grant, whose reason names
    "reconnect_needed" (fetch_google_access_token) so the panel can show it distinctly from an
    ordinary fetch failure. ``publish`` (optional) is called per created/updated/cancelled row so
    live lists refresh. ``rows`` (optional) is the user's meeting rows, read ONCE per tick by the
    sweep and shared across that user's connections — ``sync_user`` keeps the list current as it
    writes. ``client`` (optional) is a shared pinned httpx client for the feed fetch. ``admin_api_url``
    / ``internal_secret`` are required for a Google config (the access-token mint hop); an ICS
    config never uses them."""
    from . import (fetch_google_access_token, fetch_google_events, fetch_ics, parse_google_events,
                   parse_ics, sync_user)

    user_id = cfg.get("user_id")
    moment = now or datetime.now(timezone.utc)
    stamp: dict = {"last_sync": moment.isoformat(), "last_error": None}
    kind = cfg.get("kind") or "ics"
    try:
        # A tombstone (deleted) or a PAUSED (enabled: false) connection parses as an empty feed:
        # sync_user then strips this connection's sources and retires the rows only it managed.
        if cfg.get("deleted") or cfg.get("paused"):
            parsed = {"events": [], "cancelled_uids": []}
        elif kind == "google":
            if not (admin_api_url and internal_secret):
                stamp["last_error"] = "Google calendar sync is unavailable (no identity edge configured)"
                return stamp
            token, token_err = await fetch_google_access_token(
                admin_api_url, internal_secret, user_id=user_id, calendar_id=cfg.get("calendar_id"),
            )
            if token is None:
                stamp["last_error"] = token_err or "could not obtain a Google access token"
                return stamp
            window_start = moment - timedelta(seconds=DEFAULT_LOOKBACK_S)
            window_end = moment + timedelta(days=DEFAULT_HORIZON_DAYS)
            events, fetch_err = await fetch_google_events(
                token, cfg.get("google_calendar_ids") or ["primary"],
                time_min=window_start.isoformat(), time_max=window_end.isoformat(), client=client,
            )
            if events is None:
                stamp["last_error"] = fetch_err or "fetch failed"
                return stamp
            parsed = parse_google_events(events, now=moment)
        else:
            text, fetch_err = await fetch_ics(cfg["ics_url"], client=client)
            if text is None:
                stamp["last_error"] = fetch_err or "fetch failed"
                return stamp
            parsed = parse_ics(text, now=moment, redact_values=(cfg.get("ics_url") or "",))
        result = await sync_user(store, user_id, parsed,
                                 auto_join_default=bool(cfg.get("auto_join", True)),
                                 calendar_id=cfg.get("calendar_id"),
                                 calendar_name=cfg.get("calendar_name"),
                                 bot_name=cfg.get("bot_name"),
                                 legacy=bool(cfg.get("legacy")),
                                 rows=rows)
        stamp["counts"] = result.get("counts")
        if publish is not None:
            for entry in (result.get("created", []) + result.get("updated", [])
                          + result.get("cancelled", [])):
                await publish(user_id, entry)
    except Exception:
        stamp["last_error"] = ("the feed couldn't be parsed as an ICS calendar" if kind != "google"
                               else "the Google calendar response couldn't be parsed")
    return stamp


def aggregate_stamps(stamps: list[dict]) -> dict:
    """Preserve the legacy per-user status while plural feeds keep per-connection stamps."""
    counts = {"created": 0, "updated": 0, "cancelled": 0}
    for stamp in stamps:
        for key in counts:
            counts[key] += int((stamp.get("counts") or {}).get(key, 0))
    return {
        "last_sync": stamps[-1]["last_sync"],
        "last_error": next(
            (stamp["last_error"] for stamp in stamps if stamp.get("last_error")), None
        ),
        "counts": counts,
        "calendars": stamps,
    }


async def store_stamp(redis_client: Any, user_id: int, stamp: dict,
                      calendar_id: Optional[str] = None) -> None:
    """Best-effort persist of the stamp to ``cal:sync:{user_id}`` (the panel's status read)."""
    try:
        key = f"cal:sync:{user_id}:{calendar_id}" if calendar_id else f"cal:sync:{user_id}"
        await redis_client.set(key, json.dumps(stamp))
    except Exception:
        pass


async def read_stamp(redis_client: Any, user_id: int,
                     calendar_id: Optional[str] = None) -> Optional[dict]:
    """The last stamp for a user, or ``None`` when no sync has run yet."""
    try:
        key = f"cal:sync:{user_id}:{calendar_id}" if calendar_id else f"cal:sync:{user_id}"
        raw = await redis_client.get(key)
    except Exception:
        return None
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None
