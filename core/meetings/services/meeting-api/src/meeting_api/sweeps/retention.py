"""Free-plan recording retention purge (DB-78, DB-70's `recording_retention_days` catalog value).

WHAT THIS SWEEP DOES AND DOES NOT DO. `past_due` grace (`entitlements.resolve_plan`'s
`grace_until`) never deletes anything — Free limits apply after grace, but the data stays. The
ONLY deletion this sweep performs is a genuinely Free-plan recording older than the catalog's
Free retention ceiling, and it deletes through the SAME owner-scoped path a person's own
``DELETE /recordings/{id}`` uses (`recordings.deletion.delete_owned_recording`): storage objects
first, then the JSONB row — never a raw row delete that would orphan objects in MinIO/S3.

THE CATALOG VALUE IS NEVER HARDCODED HERE. `billing/catalog.py` lives in admin-api's brick; this
service reads its current number, once per TICK (not per user, not per recording), through
``fetch_free_plan_retention_days`` — a minimal batched internal read, the same shape
``calendar_sync.adapters.fetch_configs`` already uses for a deployment-wide fact. Reading it once
per tick, rather than resolving a whole user's entitlements to get a constant every user on the
plan shares, is the justification for adding this one small edge instead of reusing `bot-context`
for it too.

WHOSE RECORDINGS. `bot-context` (`/internal/users/{id}/bot-context`) is REUSED, not duplicated,
for the one question that IS per-user: is this candidate's owner still on Free right now (an
admin override, a completed upgrade, or a lapsed grace can all move that answer). Reused because
the calls are BOUNDED — at most one per DISTINCT owner in the tick's candidate batch, the same
bound `calendar_sync`'s per-user loop already relies on — so a second, batched, multi-user edge
would add a second thing to keep in sync with `bot-context`'s own resolution for no bound this
service does not already have for free.

SINGLE-FLIGHTED like every other sweep in this package (`__main__._attach_background_loops`
wraps the tick in `sweeps.single_flight`) — two replicas both listing the oldest N meetings and
both trying to delete the same recording's objects would race the storage delete twice for
nothing gained.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

from ..recordings.deletion import MeetingNotTerminal, delete_owned_recording
from ..recordings.ports import RecordingRepo, Storage

log = logging.getLogger("meeting_api.sweeps.retention")

#: Meeting rows scanned per tick, at most — the same "one bad X never stalls the whole sweep"
#: posture calendar-sync's per-user try/except gives, applied to the BATCH SIZE instead: a tick
#: costs at most this many `Meeting` rows plus at most this many distinct owners' `bot-context`
#: reads, never the whole `meetings` table.
DEFAULT_BATCH_LIMIT = 200

#: The catalog's Free plan id (`billing.catalog.DEFAULT_PLAN_ID` on admin-api) — read back off
#: `bot-context`'s own `plan_id` field rather than assumed identical to it; a deployment whose
#: admin-api ever renamed the default plan would then simply purge nothing until this constant is
#: updated to match, loudly (every candidate skipped as "not free"), never silently the wrong id.
FREE_PLAN_ID = "free"


async def fetch_free_plan_retention_days(
    admin_api_url: str, internal_secret: str, *, timeout_s: float = 10.0,
) -> Optional[int]:
    """The Free plan's CURRENT `recording_retention_days`, read live off admin-api's catalog —
    `None` when identity is unreachable or the field is missing/not a plain int, so the caller
    skips the tick (fail-closed, matching `calendar_sync.fetch_configs`'s own `None` contract)
    rather than falling back to a guessed number."""
    if not admin_api_url or not internal_secret:
        return None
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.get(
                f"{admin_api_url.rstrip('/')}/internal/billing/free-plan-retention",
                headers={"X-Internal-Secret": internal_secret},
            )
        if resp.status_code != 200:
            return None
        body = resp.json()
        days = body.get("recording_retention_days") if isinstance(body, dict) else None
        return int(days) if isinstance(days, int) and not isinstance(days, bool) else None
    except Exception:
        return None


async def fetch_user_plan_id(
    admin_api_url: str, internal_secret: str, user_id: int, *, timeout_s: float = 10.0,
) -> Optional[str]:
    """This one candidate's owner's CURRENTLY RESOLVED plan id, via the same `bot-context` edge
    every spawn already calls (DB-72) — `None` on any failure, which the sweep treats as "not
    provably Free" (skip, never delete on an unresolved answer)."""
    if not admin_api_url or not internal_secret:
        return None
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.get(
                f"{admin_api_url.rstrip('/')}/internal/users/{user_id}/bot-context",
                headers={"X-Internal-Secret": internal_secret},
            )
        if resp.status_code != 200:
            return None
        body = resp.json()
        plan_id = body.get("plan_id") if isinstance(body, dict) else None
        return plan_id if isinstance(plan_id, str) and plan_id else None
    except Exception:
        return None


async def run_retention_sweep(
    repo: RecordingRepo,
    storage: Storage,
    *,
    plan_lookup: Callable[[int], Awaitable[Optional[str]]],
    retention_days: int,
    free_plan_id: str = FREE_PLAN_ID,
    now: Optional[datetime] = None,
    batch_limit: int = DEFAULT_BATCH_LIMIT,
) -> dict:
    """One tick: the oldest ``batch_limit`` candidate recordings, Free-plan owners only, deleted
    through the proper owner-scoped path. Returns counts for the caller to log — never raises for
    one candidate's failure, the same "one bad row never stalls the sweep" rule every other loop
    in this package follows.

    ``plan_lookup(user_id)`` is awaited AT MOST ONCE per distinct owner in the batch (cached for
    the tick) — the bound that makes reusing the per-user `bot-context` edge here honest rather
    than unbounded.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=max(int(retention_days), 0))
    candidates = await repo.list_purge_candidates(cutoff, batch_limit)
    scanned = len(candidates)
    deleted = 0
    skipped_not_free = 0
    skipped_conflict = 0
    errors = 0
    plan_cache: dict[int, Optional[str]] = {}

    for row in candidates:
        user_id = row["user_id"]
        recording_id = row["recording_id"]
        if recording_id is None:
            continue
        if user_id not in plan_cache:
            try:
                plan_cache[user_id] = await plan_lookup(user_id)
            except Exception:
                log.exception("retention sweep: plan lookup failed for user %s", user_id)
                plan_cache[user_id] = None
        plan_id = plan_cache[user_id]
        if plan_id != free_plan_id:
            skipped_not_free += 1
            continue
        try:
            # The SAME path a person's own DELETE /recordings/{id} takes: storage objects first,
            # then the JSONB row — never a raw row delete that would orphan objects in the store.
            receipt = await delete_owned_recording(
                repo, storage, user_id=user_id, recording_id=recording_id,
            )
        except MeetingNotTerminal:
            skipped_conflict += 1
            continue
        except Exception:
            log.exception(
                "retention sweep: failed to delete recording %s for user %s",
                recording_id, user_id,
            )
            errors += 1
            continue
        if receipt is not None:
            deleted += 1

    log.info(
        "retention sweep: scanned=%s deleted=%s skipped_not_free=%s skipped_conflict=%s "
        "errors=%s retention_days=%s",
        scanned, deleted, skipped_not_free, skipped_conflict, errors, retention_days,
    )
    return {
        "scanned": scanned, "deleted": deleted, "skipped_not_free": skipped_not_free,
        "skipped_conflict": skipped_conflict, "errors": errors,
    }
