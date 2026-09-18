"""The usage seam (DB-70 defines it, DB-71 fills it) — mirrors this repo's ports/adapters idiom
(`meeting_api.bot_spawn.ports`, `gateway.ports`): the resolver depends on BEHAVIOR (a
`typing.Protocol`), not a concrete meter, so `entitlements.resolve_entitlements` runs unchanged
the day a real meter lands.

`NullUsagePort` reports usage as UNKNOWN, never as zero. Those are different answers: zero says
"we checked, you used nothing"; unknown says "nobody has wired the meter yet". A client that
renders unknown as zero — "0 of 1 used" — is lying to the user about a fact nobody actually
counted. Every consumer of `UsageSnapshot` MUST treat `None` as "cannot say", not as 0.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Protocol, runtime_checkable


@dataclass(frozen=True)
class UsageSnapshot:
    """Usage within one billing period. `None` on either field means UNKNOWN — no meter has
    reported a count — and is never to be conflated with 0 (a real, counted, empty period)."""

    meetings_used: Optional[int]
    minutes_used: Optional[int]


@runtime_checkable
class UsagePort(Protocol):
    """The meter DB-71 supplies. `resolve_entitlements` calls this once per resolution to learn
    how much of the resolved period's allowance is already spent."""

    async def usage_for_period(
        self, user_id: int, *, period_start: datetime, period_end: datetime
    ) -> UsageSnapshot:
        """This user's meetings/minutes counted inside `[period_start, period_end)`.

        `period_end` is exclusive, matching `entitlements.resolve_entitlements`'s own period
        boundaries (a calendar month runs `[1st 00:00 UTC, 1st-of-next-month 00:00 UTC)`)."""
        ...


class NullUsagePort:
    """The adapter that exists until DB-71 lands. Reports every period as UNKNOWN usage — see
    module docstring for why that is not 0. `resolve_entitlements` defaults to this so a caller
    who has not wired a real meter still gets a correctly-shaped (if unknown) answer."""

    async def usage_for_period(
        self, user_id: int, *, period_start: datetime, period_end: datetime
    ) -> UsageSnapshot:
        return UsageSnapshot(meetings_used=None, minutes_used=None)
