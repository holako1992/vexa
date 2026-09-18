"""The plan catalog — one file, one source of truth (DB-70).

Changing a price tier's limits is a one-line edit here, not a hunt across the codebase. Every
consumer (the resolver in this package, DB-72's spawn-time enforcement, DB-74's billing page)
reads plans through `PLANS` / `get_plan`, never by re-deriving a number.

UNLIMITED is a single explicit sentinel — `None` meaning "no ceiling" — never a large integer.
A large integer is a number that can be exceeded and compared; `None` cannot, so a consumer that
forgets to special-case it fails loudly (a `TypeError` on `used >= None`) instead of quietly
enforcing a cap nobody asked for. Every consumer of `PlanLimits` MUST check for `None` before
doing arithmetic on a limit field.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

#: `PlatformBillingDataPatch.billing_catalog_version` (main.py) already carries this spelling of
#: the concept — bump this string whenever a plan's limits change, so a resolved entitlement can
#: say which catalog priced it.
CATALOG_VERSION = "2026-09-18"

#: The sentinel for "no ceiling". Never replace with a large int (see module docstring).
UNLIMITED: Optional[int] = None


@dataclass(frozen=True)
class PlanLimits:
    """One plan's limits, as data. `None` on any field means unlimited — see `UNLIMITED`."""

    plan_id: str
    #: Meetings started per calendar month (UTC). `None` = unlimited.
    meetings_per_month: Optional[int]
    #: Ceiling on a single meeting's duration, in minutes. `None` = unlimited.
    max_minutes_per_meeting: Optional[int]
    #: Concurrent bots the user may run at once (the same number the gateway injects as
    #: `x-user-limits` and `meeting_api.bot_spawn.router._resolve_max_concurrent` parses).
    concurrent_bots: int
    #: Days a completed meeting's recording/transcript is retained. `None` = unlimited.
    recording_retention_days: Optional[int]
    #: AI summaries generated per calendar month (UTC). `None` = unlimited.
    ai_summaries_per_month: Optional[int]


PLANS: Dict[str, PlanLimits] = {
    "free": PlanLimits(
        plan_id="free",
        meetings_per_month=1,
        max_minutes_per_meeting=60,
        concurrent_bots=1,
        recording_retention_days=7,
        ai_summaries_per_month=1,
    ),
    "pro": PlanLimits(
        plan_id="pro",
        meetings_per_month=UNLIMITED,
        max_minutes_per_meeting=240,
        concurrent_bots=2,
        recording_retention_days=365,
        ai_summaries_per_month=UNLIMITED,
    ),
    "team": PlanLimits(
        plan_id="team",
        meetings_per_month=UNLIMITED,
        max_minutes_per_meeting=240,
        concurrent_bots=5,
        recording_retention_days=UNLIMITED,
        ai_summaries_per_month=UNLIMITED,
    ),
}

#: The plan a user resolves to with no subscription fields set, an expired grace window, or an
#: unrecognized tier string. Every plan in `PLANS` other than this one is a PAID plan.
DEFAULT_PLAN_ID = "free"

#: How long a `past_due` subscription still resolves to its paid tier before falling back to
#: `DEFAULT_PLAN_ID` — the dunning window Stripe's own retry schedule is built around.
PAST_DUE_GRACE_DAYS = 7


def get_plan(plan_id: Optional[str]) -> PlanLimits:
    """`PLANS[plan_id]`, or the default plan for `None`/an unrecognized id.

    Never raises — an unrecognized tier string is a fact for the caller to log (see
    `entitlements.resolve_entitlements`), not an exception for this pure lookup to throw.
    """
    if plan_id is None:
        return PLANS[DEFAULT_PLAN_ID]
    return PLANS.get(plan_id, PLANS[DEFAULT_PLAN_ID])
