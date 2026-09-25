"""DB-71 — the real `UsagePort`: usage counted from the existing `meetings` rows.

No second table, no counter incremented alongside meeting creation. `schema/models.py`'s
`Meeting` (the shared table `core/meetings/services/meeting-api` also writes) already records
that a meeting happened; this module is the ONE place that turns those rows into a count.

**Which rows consume the quota.** Product rule: a bot that never got into the meeting must not
consume the user's one free meeting. `meeting_api.lifecycle.machine` (read, not imported —
admin-api never depends on meeting-api at runtime) is the source for the status vocabulary this
rule is built from:

* `completed` is reachable ONLY from `active` in the bot FSM (`machine.LEGAL_TRANSITIONS`,
  `core/meetings/services/meeting-api/src/meeting_api/lifecycle/machine.py:123`) — every
  `completed` row is a row whose bot got in.
* `stopping` is the server-side in-flight-stop state, written "ONLY over a status in which the
  bot reached the meeting" (`machine.py:136-139`) — so a `stopping` row also got in.
* `active` is, definitionally, a bot currently in the room.
* `failed` is ambiguous BY ITSELF — the vocabulary cannot tell "never joined" from "joined then
  crashed" from the status string alone. `data.failure_stage` is the disambiguator the parent
  already writes for exactly this
  (`core/meetings/services/meeting-api/src/meeting_api/lifecycle/occurrence.py:19-22`:
  "``status='failed'`` with ``failure_stage='active'`` — admitted, then the run broke"). A
  `failed` row counts ONLY when `data.failure_stage == "active"`; every other `failed` row
  (`requested`/`joining`/`awaiting_admission` failure stages) never got in and does not count.
* `requested`, `joining`, `awaiting_admission`, `needs_help` are all pre-admission — never
  counted, however long they sit there. A pending bot that later becomes `active` starts
  counting the moment that happens, because this is a live query, not a ledger.

This mirrors `occurrence.disposition`'s SERVED rule one-for-one (that module is meeting-api's
retry-eligibility gate, a different question — "may this occurrence be dispatched again?" — that
happens to be built on the same admitted/not-admitted line). admin-api does not import it: the
line is short enough, and load-bearing enough, to restate here in admin-api's own vocabulary
rather than take a cross-service runtime dependency on meeting-api for one boolean.

**Minutes.** `end_time - start_time` for every counted row. A `null` end_time (a still-`active`
or still-`stopping` meeting) is counted up to `now` — the meeting is consuming the user's month
AS IT RUNS, not retroactively once it ends — never silently coerced to 0 or a negative span. A
`null` start_time (should not happen for anything past `requested`, but the column is nullable)
contributes 0 minutes rather than raising: the meeting still consumed a slot, its duration is
just unknown.

**Failure mode.** `meetings_usage_for_period` never raises past its own try/except — a query
failure returns `UsageSnapshot(None, None)` (UNKNOWN), the same shape `NullUsagePort` returns
when nothing is wired at all. `ports.py`'s module docstring is the reason: unknown and zero are
different facts, and a caller (the `/user/entitlements` endpoint today, DB-72's spawn-time
enforcement tomorrow) that turned "the query broke" into "0 used" would let a user who is
actually over quota read as under it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...schema.models import Meeting
from .ports import UsageSnapshot

log = logging.getLogger("admin_api.billing.meetings_usage")

#: Statuses that, by themselves (no need to look at `data`), mean the bot reached the room.
#: See the module docstring for the machine.py/occurrence.py citations this is built from.
_JOINED_STATUSES = frozenset({"active", "stopping", "completed"})

#: The one `failed` sub-case that also means the bot reached the room: admitted, then broke.
_FAILED_BUT_JOINED_STAGE = "active"


def _is_consumed(status: Optional[str], data: Optional[dict]) -> bool:
    """Did this row's bot reach the meeting? — the sole test for whether it consumes quota."""
    if status in _JOINED_STATUSES:
        return True
    if status == "failed":
        stage = (data or {}).get("failure_stage") if isinstance(data, dict) else None
        return stage == _FAILED_BUT_JOINED_STAGE
    return False


def _naive_utc(dt: datetime) -> datetime:
    """`Meeting.created_at`/`start_time`/`end_time` are `DateTime` with no timezone (Postgres
    `timestamp without time zone`, always written/read as UTC by convention elsewhere in this
    codebase — see `main.py`'s `APIToken.expires_at` vs. `datetime.utcnow()`). `resolve_plan`'s
    `period_start`/`period_end` are tz-aware UTC; binding a tz-aware value against a naive column
    is what asyncpg rejects, so every boundary crosses this once before it reaches SQL."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _minutes(start_time: Optional[datetime], end_time: Optional[datetime], now: datetime) -> int:
    """Whole minutes between `start_time` and `end_time` (or `now` when the meeting is still
    running) — never negative, never a `None` masquerading as 0 minutes' worth of usage."""
    if start_time is None:
        return 0
    end = end_time if end_time is not None else now
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    span = (end - start_time).total_seconds() / 60.0
    return max(0, int(span))


async def meetings_usage_for_period(
    db: AsyncSession, user_id: int, *, period_start: datetime, period_end: datetime,
) -> UsageSnapshot:
    """This user's consumed meetings + minutes inside `[period_start, period_end)`, counted from
    `meetings` rows. `period_end` is exclusive, matching `resolve_plan`'s own period boundaries.

    THE function DB-72 (spawn-time quota enforcement) reuses unmodified — same signature, same
    `db: AsyncSession` first argument it already holds via `Depends(get_db)`.

    The `WHERE user_id = ... AND created_at >= period_start AND created_at < period_end` shape is
    exactly what `ix_meeting_user_created_at` (`schema/models.py`'s `Meeting.__table_args__`) is
    built to serve; `status`/`data` are read alongside for the in-Python join-classification
    above rather than pushed into SQL, so the one `_is_consumed` rule stays a single, readable,
    unit-testable function instead of a CASE expression duplicated between here and a future
    DB-72 query.

    Never raises: a DB error is logged and reported as UNKNOWN usage, never as 0 (see module
    docstring).
    """
    try:
        window_start = _naive_utc(period_start)
        window_end = _naive_utc(period_end)
        rows = (await db.execute(
            select(Meeting.status, Meeting.start_time, Meeting.end_time, Meeting.data).where(
                and_(
                    Meeting.user_id == user_id,
                    Meeting.created_at >= window_start,
                    Meeting.created_at < window_end,
                )
            )
        )).all()
    except Exception:
        log.exception(
            "billing.meetings_usage: usage query failed for user_id=%r period=[%s, %s) — "
            "reporting UNKNOWN, never 0", user_id, period_start, period_end,
        )
        return UsageSnapshot(meetings_used=None, minutes_used=None)

    now = datetime.now(timezone.utc)
    meetings_used = 0
    minutes_used = 0
    for status, start_time, end_time, data in rows:
        if not _is_consumed(status, data):
            continue
        meetings_used += 1
        minutes_used += _minutes(start_time, end_time, now)

    return UsageSnapshot(meetings_used=meetings_used, minutes_used=minutes_used)


class MeetingsUsagePort:
    """The `UsagePort` adapter DB-71 promised — wraps `meetings_usage_for_period` against one
    request's `AsyncSession` so `resolve_entitlements(data, now, user.id, usage_port=...)` gets a
    real meter instead of `NullUsagePort`'s permanent UNKNOWN."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def usage_for_period(
        self, user_id: int, *, period_start: datetime, period_end: datetime
    ) -> UsageSnapshot:
        return await meetings_usage_for_period(
            self._db, user_id, period_start=period_start, period_end=period_end,
        )
