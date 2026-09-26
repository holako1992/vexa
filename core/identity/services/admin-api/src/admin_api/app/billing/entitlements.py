"""The entitlement resolver (DB-70) — maps a user's stored billing data to what they are
actually allowed right now.

`resolve_plan` is the pure core: no database, no clock read, no I/O. It takes the user's
`users.data` JSON blob (the fields `PlatformBillingDataPatch` writes into it) and `now` as plain
arguments and returns a `ResolvedPlan` — deterministic, so the acceptance table in DB-70's issue
is a table of `resolve_plan(data, now) == expected` assertions, not a fixture-and-mock exercise.

`resolve_entitlements` is the thin async layer on top: it calls `resolve_plan` for the plan/period
and then asks a `ports.UsagePort` how much of that period is already spent. DB-72 (quota
enforcement at spawn) is the intended caller of `resolve_entitlements` — see its docstring for the
exact signature.

**DB-77 admin overrides** are applied inside `resolve_plan`, at the very end, on top of whatever
the Stripe-derived resolution above produced. There is exactly ONE place a plan is decided
(`resolve_plan`) and every consumer of overrides — `/user/entitlements`, `/internal/validate`,
`/internal/users/{id}/bot-context` (meeting-api's quota check) — reads through it, so an admin
comp is visible everywhere at once with no second code path to keep in sync:

  * `data["plan_override"]` — a catalog plan id (`billing.catalog.PLANS`) that WINS over the
    Stripe-derived tier outright. `None`/absent leaves the Stripe resolution alone. The write
    path (`PATCH /admin/users/{id}`) already rejects an unrecognized plan id with 422, but this
    reader stays defensive: a stale override left over from a retired catalog entry is logged and
    ignored (same posture as an unrecognized `subscription_tier`) rather than crashing the spawn
    path.
  * `data["quota_bonus"]` — a non-negative int, extra meetings added to `meetings_per_month` for
    ONE period only: `data["quota_bonus_period_start"]` (a unix timestamp) must equal the
    resolved plan's `period_start` exactly, or the bonus does not apply. This is the simplest
    honest design: a bonus is tied to the specific period it was granted for, so a comp silently
    surviving into next month (or applying retroactively to a past one) is impossible — support
    grants a NEW bonus each period it wants to comp. `PATCH /admin/users/{id}` stamps
    `quota_bonus_period_start` to the CURRENT resolved period when it sets `quota_bonus`, so the
    admin only ever supplies the count. A bonus is irrelevant (never added, never reported) when
    the plan's `meetings_per_month` is already `UNLIMITED` — there is nothing to add to.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from .catalog import CATALOG_VERSION, DEFAULT_PLAN_ID, PAST_DUE_GRACE_DAYS, PLANS, PlanLimits, get_plan
from .ports import NullUsagePort, UsagePort, UsageSnapshot

log = logging.getLogger("admin_api.billing.entitlements")

#: Subscription statuses that resolve to their tier's plan outright (no grace, no period check
#: beyond falling back to the calendar month when no Stripe period is stored).
_PAID_STATUSES = ("active", "trialing")


@dataclass(frozen=True)
class ResolvedPlan:
    """The pure result of `resolve_plan` — a plan + the period it applies to, no usage."""

    plan_id: str
    limits: PlanLimits
    #: The raw `subscription_status` as stored (`None` when no subscription fields exist at all).
    status: Optional[str]
    period_start: datetime
    period_end: datetime
    #: Set only while a `past_due` subscription is still inside its grace window.
    grace_until: Optional[datetime]
    #: Whether the resolved plan renews at `period_end` (False for `cancel_at_period_end=true`,
    #: a `canceled` subscription still coasting to its paid `period_end`, and a lapsed `past_due`).
    will_renew: bool
    catalog_version: str
    #: The raw tier string, when it did not match any entry in `catalog.PLANS` (else `None`).
    #: Set so a caller can tell "resolved to free because nothing was ever set" apart from
    #: "resolved to free because the stored tier was garbage" — the latter is DB-70's acceptance
    #: row that must be logged, not silently coerced.
    unrecognized_tier: Optional[str] = None
    #: DB-77: the raw `plan_override`, when it named a catalog plan and won over the
    #: Stripe-derived tier above (`None` when no override was applied, whether because none was
    #: stored or because it named a plan `catalog.PLANS` no longer has — see `unrecognized_plan_override`).
    plan_override: Optional[str] = None
    #: DB-77: `plan_override` was stored but did not match any entry in `catalog.PLANS` — same
    #: "log and ignore, never guess" posture as `unrecognized_tier`.
    unrecognized_plan_override: Optional[str] = None
    #: DB-77: how many extra meetings `quota_bonus` actually added to this resolution's
    #: `limits.meetings_per_month` — 0 when no bonus is stored, it targets a different period, or
    #: the plan's meetings are already unlimited. Reported so a caller can show "+1 comped" rather
    #: than re-deriving it from the raw stored fields.
    quota_bonus_applied: int = 0


@dataclass(frozen=True)
class ResolvedEntitlements:
    """`ResolvedPlan` plus the current period's usage — what `GET /user/entitlements` returns."""

    plan: ResolvedPlan
    usage: UsageSnapshot


def _calendar_month_bounds(now: datetime) -> tuple[datetime, datetime]:
    """`[1st 00:00 UTC of now's month, 1st 00:00 UTC of the next month)` — the free plan's
    reset period. Exclusive upper bound: 00:00:00 on the 1st is already the NEXT period."""
    start = now.replace(hour=0, minute=0, second=0, microsecond=0, day=1)
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start, end


def _from_unix(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _as_utc(now: datetime) -> datetime:
    """Callers are expected to pass a UTC-aware `now` (the resolver never reads the clock
    itself); a naive value is treated as already-UTC rather than raising, so a test fixture
    built with `datetime(2026, 9, 1)` behaves the way it reads."""
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc)


def _free_result(
    *, status: Optional[str], now: datetime, grace_until: Optional[datetime],
    will_renew: bool, unrecognized_tier: Optional[str],
) -> ResolvedPlan:
    cal_start, cal_end = _calendar_month_bounds(now)
    return ResolvedPlan(
        plan_id=DEFAULT_PLAN_ID,
        limits=get_plan(DEFAULT_PLAN_ID),
        status=status,
        period_start=cal_start,
        period_end=cal_end,
        grace_until=grace_until,
        will_renew=will_renew,
        catalog_version=CATALOG_VERSION,
        unrecognized_tier=unrecognized_tier,
    )


def resolve_plan(data: Dict[str, Any], now: datetime) -> ResolvedPlan:
    """The pure resolution — see module docstring. `data` is the user's `users.data` blob (the
    `PlatformBillingDataPatch` fields, plus DB-77's `plan_override`/`quota_bonus`/
    `quota_bonus_period_start`; anything else in the blob is ignored). DB-77 overrides are the
    LAST step, applied uniformly on whatever `_resolve_subscription_plan` below produced."""
    return _apply_admin_overrides(_resolve_subscription_plan(data, now), data)


def _apply_admin_overrides(plan: ResolvedPlan, data: Dict[str, Any]) -> ResolvedPlan:
    """DB-77: `plan_override` wins over the Stripe-derived tier; `quota_bonus` adds to
    `meetings_per_month` for the one period it was granted for. See module docstring."""
    plan_id = plan.plan_id
    limits = plan.limits
    unrecognized_override: Optional[str] = None

    override = data.get("plan_override")
    applied_override: Optional[str] = None
    if override is not None:
        if override in PLANS:
            plan_id = override
            limits = get_plan(override)
            applied_override = override
        else:
            unrecognized_override = override
            log.warning(
                "billing.entitlements: unrecognized plan_override=%r — ignoring, resolving as "
                "if no override were stored", override,
            )

    quota_bonus_applied = 0
    raw_bonus = data.get("quota_bonus")
    bonus_period_start = _from_unix(data.get("quota_bonus_period_start"))
    if (
        isinstance(raw_bonus, int)
        and raw_bonus > 0
        and bonus_period_start == plan.period_start
        and limits.meetings_per_month is not None
    ):
        quota_bonus_applied = raw_bonus
        limits = replace(limits, meetings_per_month=limits.meetings_per_month + quota_bonus_applied)

    if applied_override is None and unrecognized_override is None and quota_bonus_applied == 0:
        return plan
    return replace(
        plan,
        plan_id=plan_id,
        limits=limits,
        plan_override=applied_override,
        unrecognized_plan_override=unrecognized_override,
        quota_bonus_applied=quota_bonus_applied,
    )


def _resolve_subscription_plan(data: Dict[str, Any], now: datetime) -> ResolvedPlan:
    """The Stripe-derived resolution, before DB-77's admin overrides (`resolve_plan` applies
    those). Unchanged from DB-70 except for the rename."""
    now = _as_utc(now)
    status = data.get("subscription_status")
    tier = data.get("subscription_tier")
    cancel_at_period_end = bool(data.get("subscription_cancel_at_period_end") or False)
    stored_start = _from_unix(data.get("subscription_current_period_start"))
    stored_end = _from_unix(data.get("subscription_current_period_end"))
    cal_start, cal_end = _calendar_month_bounds(now)
    period_start = stored_start or cal_start
    period_end = stored_end or cal_end

    # No subscription fields at all → free, calendar-month period. The common case: a person who
    # signed up and never paid.
    if status is None and tier is None:
        return _free_result(status=None, now=now, grace_until=None, will_renew=True,
                            unrecognized_tier=None)

    unrecognized_tier = tier if (tier is not None and tier not in PLANS) else None
    if unrecognized_tier is not None:
        log.warning(
            "billing.entitlements: unrecognized subscription_tier=%r (status=%r) — "
            "resolving to %s rather than guessing", tier, status, DEFAULT_PLAN_ID,
        )
    tier_plan = get_plan(tier)  # falls back to DEFAULT_PLAN_ID itself when tier is None/garbage

    if status in _PAID_STATUSES:
        return ResolvedPlan(
            plan_id=tier_plan.plan_id, limits=tier_plan, status=status,
            period_start=period_start, period_end=period_end, grace_until=None,
            will_renew=not cancel_at_period_end, catalog_version=CATALOG_VERSION,
            unrecognized_tier=unrecognized_tier,
        )

    if status == "past_due":
        grace_until = period_end + timedelta(days=PAST_DUE_GRACE_DAYS)
        if now <= grace_until:
            return ResolvedPlan(
                plan_id=tier_plan.plan_id, limits=tier_plan, status=status,
                period_start=period_start, period_end=period_end, grace_until=grace_until,
                will_renew=False, catalog_version=CATALOG_VERSION,
                unrecognized_tier=unrecognized_tier,
            )
        # Grace window has lapsed — no more benefit of the doubt.
        return _free_result(status=status, now=now, grace_until=grace_until, will_renew=False,
                            unrecognized_tier=unrecognized_tier)

    if status == "canceled":
        if now < period_end:
            # Already paid through period_end — Stripe's own "cancel effective at period end"
            # shape, just observed after the cancellation already recorded.
            return ResolvedPlan(
                plan_id=tier_plan.plan_id, limits=tier_plan, status=status,
                period_start=period_start, period_end=period_end, grace_until=None,
                will_renew=False, catalog_version=CATALOG_VERSION,
                unrecognized_tier=unrecognized_tier,
            )
        return _free_result(status=status, now=now, grace_until=None, will_renew=True,
                            unrecognized_tier=unrecognized_tier)

    # An unrecognized STATUS string (not one of active/trialing/past_due/canceled). Same
    # conservative posture as an unrecognized tier: fall back to free rather than guess, and say
    # so in the log so it shows up as an anomaly rather than a silent mischarge.
    log.warning(
        "billing.entitlements: unrecognized subscription_status=%r (tier=%r) — "
        "resolving to %s rather than guessing", status, tier, DEFAULT_PLAN_ID,
    )
    return _free_result(status=status, now=now, grace_until=None, will_renew=True,
                        unrecognized_tier=unrecognized_tier)


async def resolve_entitlements(
    data: Dict[str, Any],
    now: datetime,
    user_id: int,
    usage_port: Optional[UsagePort] = None,
) -> ResolvedEntitlements:
    """`resolve_plan` plus usage for that plan's period.

    **DB-72 (quota enforcement at spawn) calls this function** — `resolve_entitlements(user.data,
    datetime.now(timezone.utc), user.id, usage_port)` — to get the plan's limits (`.plan.limits`,
    including `concurrent_bots`, which the gateway/`x-user-limits` path already enforces
    separately, and `meetings_per_month`, which nothing enforces yet) alongside how much of the
    current period is already spent (`.usage`, `None` fields meaning UNKNOWN until DB-71 wires a
    real `UsagePort`). `usage_port` defaults to `ports.NullUsagePort()` when omitted.
    """
    port = usage_port if usage_port is not None else NullUsagePort()
    plan = resolve_plan(data, now)
    usage = await port.usage_for_period(
        user_id, period_start=plan.period_start, period_end=plan.period_end,
    )
    return ResolvedEntitlements(plan=plan, usage=usage)
