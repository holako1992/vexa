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

import os
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

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


#: `users.max_concurrent_bots`' column default (`schema.sql`) — the value every user carries until
#: an operator explicitly sets a different one via `PATCH /admin/users/{id}`. DB-72
#: (`effective_concurrent_cap` below) treats a stored value still AT this default as "no admin
#: override yet", never as a deliberate 3-bot ceiling.
LEGACY_MAX_CONCURRENT_BOTS_DEFAULT = 3


def effective_concurrent_cap(
    plan_concurrent_bots: int, stored_max_concurrent_bots: Optional[int]
) -> int:
    """Combine the resolved plan's `concurrent_bots` with the pre-billing
    `users.max_concurrent_bots` column into the ONE number `/internal/validate` returns as
    `max_concurrent` — the number the gateway injects as `x-user-limits` and
    `meeting_api.bot_spawn.router._resolve_max_concurrent` enforces (DB-72).

    The stored column PREDATES billing: every user carries it, defaulted to
    `LEGACY_MAX_CONCURRENT_BOTS_DEFAULT`. Raising a user above their plan is DB-77's job
    (`plan_override`/`quota_bonus`, applied inside `entitlements.resolve_plan` — the `plan_concurrent_bots`
    this function receives already reflects any override). This function's OWN job stays narrow: the
    stored column keeps its pre-billing meaning, an operator-settable HARD CEILING that can only
    narrow a user's cap, never widen it past whatever plan (overridden or not) they resolved to:

      * stored value is `None` or still the untouched default → the PLAN decides alone (a paying
        Pro/Team user nobody has ever touched with `PATCH /admin/users/{id}` gets their plan's
        2/5, not clamped down to the legacy default of 3);
      * stored value has been explicitly set to something ELSE → the LOWER of the two wins (an
        operator's explicit value always narrows the cap, it never widens a user past their plan
        — raising someone above their plan is DB-77's job, not this column's).

    PRODUCT CHANGE, stated once here rather than left implicit in a diff: every existing Free
    user's column reads the untouched default of 3 (nobody has been through `PATCH
    /admin/users/{id}` for this reason yet), so before this function existed a Free user could run
    up to 3 concurrent bots. The Free plan's `concurrent_bots` is 1, so `effective_concurrent_cap`
    takes every untouched Free user from 3 down to 1 the moment DB-72 ships. That IS the product's
    free tier, not a bug — DB-72's report states it plainly for the same reason this comment does.
    """
    if (
        stored_max_concurrent_bots is None
        or stored_max_concurrent_bots == LEGACY_MAX_CONCURRENT_BOTS_DEFAULT
    ):
        return plan_concurrent_bots
    return min(plan_concurrent_bots, stored_max_concurrent_bots)


# ── Stripe price ↔ catalog plan (DB-73) ─────────────────────────────────────────────────────────
#
# THIS IS THE ONE PLACE A STRIPE PRICE ID BECOMES A PLAN. The webhook handler
# (`billing/stripe_webhook.py`) and the checkout endpoint (`main.py`) both go through
# `price_id_for`/`plan_for_price_id` — neither one hardcodes a `price_...` literal, and neither
# reinterprets a plan's meaning. A price id is never invented here: each entry names the ENV VAR
# that carries it (set per-deployment from the operator's own Stripe dashboard), so a self-host
# with no Stripe account configured simply has every entry resolve to `None` — never a placeholder
# id that would silently checkout against nothing.
#
# Free carries no price — there is nothing to buy to get it, and a webhook can never move a user
# TO free by price id (only by the absence/expiry of a paid subscription, in `entitlements.py`).
PLAN_INTERVALS = ("month", "year")

#: (plan_id, interval) -> the env var that carries that price's Stripe id. Every paid plan ×
#: interval combination the catalog defines gets one row; a plan the catalog does not define
#: (there is no third paid plan) simply has no row, so `price_id_for` on it is a KeyError-free
#: `None` rather than a typo silently doing the wrong thing.
STRIPE_PRICE_ENV: Dict[Tuple[str, str], str] = {
    ("pro", "month"): "STRIPE_PRICE_PRO_MONTHLY",
    ("pro", "year"): "STRIPE_PRICE_PRO_YEARLY",
    ("team", "month"): "STRIPE_PRICE_TEAM_MONTHLY",
    ("team", "year"): "STRIPE_PRICE_TEAM_YEARLY",
}


def price_id_for(plan_id: str, interval: str, env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """The configured Stripe price id for `(plan_id, interval)`, or `None` when the plan/interval
    combination does not exist in the catalog, or the operator has not set that env var.

    Read AT CALL TIME (no boot-time snapshot) — same rule `config_preflight.py` uses — so a test
    monkeypatching the environment and a long-lived process both observe the truth.
    """
    env_key = STRIPE_PRICE_ENV.get((plan_id, interval))
    if not env_key:
        return None
    source = env if env is not None else os.environ
    return (source.get(env_key) or "").strip() or None


def plan_for_price_id(price_id: str, env: Optional[Dict[str, str]] = None) -> Optional[Tuple[str, str]]:
    """The `(plan_id, interval)` a Stripe price id resolves to, or `None` when it matches nothing
    this deployment has configured — an unrecognized price is the caller's to LOG AND IGNORE
    (never guess), see `billing/stripe_webhook.py`."""
    if not price_id:
        return None
    source = env if env is not None else os.environ
    for (plan_id, interval), env_key in STRIPE_PRICE_ENV.items():
        configured = (source.get(env_key) or "").strip()
        if configured and configured == price_id:
            return (plan_id, interval)
    return None
