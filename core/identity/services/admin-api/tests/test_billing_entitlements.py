"""DB-70 — the plan catalog + the entitlement resolver.

Pure logic, no database: `resolve_plan` takes `data` (the `users.data` blob) and `now` as plain
arguments and is deterministic, so this suite runs with no docker, no testcontainers, no FastAPI
app — every row below is a `resolve_plan(data, now) == expected` assertion, which is the whole
point of keeping the resolver pure (see `admin_api.app.billing.entitlements`'s module docstring).

The endpoint (`GET /user/entitlements`) and its auth are covered separately in
`test_billing_entitlements_endpoint.py`, which DOES need the testcontainers-PG stack.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from admin_api.app.billing.catalog import CATALOG_VERSION, PAST_DUE_GRACE_DAYS, PLANS
from admin_api.app.billing.entitlements import resolve_entitlements, resolve_plan
from admin_api.app.billing.ports import NullUsagePort, UsageSnapshot

UTC = timezone.utc


def _unix(dt: datetime) -> int:
    return int(dt.timestamp())


def test_no_subscription_fields_resolves_free():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    plan = resolve_plan({}, now)
    assert plan.plan_id == "free"
    assert plan.status is None
    assert plan.will_renew is True
    assert plan.grace_until is None
    assert plan.unrecognized_tier is None
    assert plan.period_start == datetime(2026, 9, 1, tzinfo=UTC)
    assert plan.period_end == datetime(2026, 10, 1, tzinfo=UTC)


def test_active_pro_resolves_pro():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {"subscription_status": "active", "subscription_tier": "pro"}
    plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"
    assert plan.status == "active"
    assert plan.will_renew is True
    assert plan.grace_until is None
    assert plan.limits.concurrent_bots == 2
    assert plan.limits.meetings_per_month is None  # unlimited


def test_trialing_pro_resolves_pro():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {"subscription_status": "trialing", "subscription_tier": "pro"}
    plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"
    assert plan.status == "trialing"
    assert plan.will_renew is True


def test_past_due_within_grace_resolves_pro_with_grace_until():
    period_end = datetime(2026, 9, 10, tzinfo=UTC)
    now = period_end + timedelta(days=2)  # inside the 7-day grace window
    data = {
        "subscription_status": "past_due",
        "subscription_tier": "pro",
        "subscription_current_period_start": _unix(datetime(2026, 8, 10, tzinfo=UTC)),
        "subscription_current_period_end": _unix(period_end),
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"
    assert plan.status == "past_due"
    assert plan.will_renew is False
    assert plan.grace_until == period_end + timedelta(days=PAST_DUE_GRACE_DAYS)


def test_past_due_grace_expired_resolves_free():
    period_end = datetime(2026, 9, 10, tzinfo=UTC)
    now = period_end + timedelta(days=PAST_DUE_GRACE_DAYS, seconds=1)  # one second past grace
    data = {
        "subscription_status": "past_due",
        "subscription_tier": "pro",
        "subscription_current_period_end": _unix(period_end),
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "free"
    assert plan.status == "past_due"
    assert plan.grace_until is not None  # the fact that grace lapsed is still reported


def test_canceled_with_future_period_end_resolves_pro_until_end():
    period_end = datetime(2026, 9, 20, tzinfo=UTC)
    now = datetime(2026, 9, 15, tzinfo=UTC)  # still inside the paid period
    data = {
        "subscription_status": "canceled",
        "subscription_tier": "pro",
        "subscription_current_period_start": _unix(datetime(2026, 9, 1, tzinfo=UTC)),
        "subscription_current_period_end": _unix(period_end),
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"
    assert plan.status == "canceled"
    assert plan.will_renew is False
    assert plan.period_end == period_end


def test_canceled_with_past_period_end_resolves_free():
    period_end = datetime(2026, 9, 5, tzinfo=UTC)
    now = datetime(2026, 9, 15, tzinfo=UTC)  # the paid period is over
    data = {
        "subscription_status": "canceled",
        "subscription_tier": "pro",
        "subscription_current_period_end": _unix(period_end),
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "free"
    assert plan.status == "canceled"


def test_cancel_at_period_end_true_still_active_resolves_pro_wont_renew():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {
        "subscription_status": "active",
        "subscription_tier": "pro",
        "subscription_cancel_at_period_end": True,
        "subscription_current_period_end": _unix(datetime(2026, 9, 30, tzinfo=UTC)),
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"
    assert plan.will_renew is False


def test_unrecognized_tier_resolves_free_and_is_logged(caplog):
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {"subscription_status": "active", "subscription_tier": "enterprise-legacy-v1"}
    with caplog.at_level("WARNING", logger="admin_api.billing.entitlements"):
        plan = resolve_plan(data, now)
    assert plan.plan_id == "free"
    assert plan.unrecognized_tier == "enterprise-legacy-v1"
    assert any("unrecognized subscription_tier" in rec.message for rec in caplog.records)


def test_unrecognized_status_resolves_free_and_is_logged(caplog):
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {"subscription_status": "some_future_stripe_status", "subscription_tier": "pro"}
    with caplog.at_level("WARNING", logger="admin_api.billing.entitlements"):
        plan = resolve_plan(data, now)
    assert plan.plan_id == "free"
    assert any("unrecognized subscription_status" in rec.message for rec in caplog.records)


def test_unlimited_is_none_sentinel_never_a_large_int():
    for plan_id in ("pro", "team"):
        limits = PLANS[plan_id]
        assert limits.meetings_per_month is None
        assert limits.ai_summaries_per_month is None
    assert PLANS["team"].recording_retention_days is None
    # the free plan is fully bounded — nothing about it is unlimited
    free = PLANS["free"]
    assert free.meetings_per_month == 1
    assert free.recording_retention_days == 7


def test_calendar_month_boundary_end_of_month_vs_start_of_next():
    late_august = datetime(2026, 8, 31, 23, 59, tzinfo=UTC)
    plan_aug = resolve_plan({}, late_august)
    assert plan_aug.period_start == datetime(2026, 8, 1, tzinfo=UTC)
    assert plan_aug.period_end == datetime(2026, 9, 1, tzinfo=UTC)

    early_september = datetime(2026, 9, 1, 0, 1, tzinfo=UTC)
    plan_sep = resolve_plan({}, early_september)
    assert plan_sep.period_start == datetime(2026, 9, 1, tzinfo=UTC)
    assert plan_sep.period_end == datetime(2026, 10, 1, tzinfo=UTC)


def test_calendar_month_boundary_december_rolls_year():
    now = datetime(2026, 12, 15, tzinfo=UTC)
    plan = resolve_plan({}, now)
    assert plan.period_start == datetime(2026, 12, 1, tzinfo=UTC)
    assert plan.period_end == datetime(2027, 1, 1, tzinfo=UTC)


def test_catalog_version_is_stamped_on_every_resolution():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    assert resolve_plan({}, now).catalog_version == CATALOG_VERSION
    assert resolve_plan({"subscription_status": "active", "subscription_tier": "team"},
                        now).catalog_version == CATALOG_VERSION


def test_resolve_entitlements_null_usage_port_reports_unknown_not_zero():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    resolved = asyncio.run(resolve_entitlements({}, now, user_id=42))
    assert resolved.usage == UsageSnapshot(meetings_used=None, minutes_used=None)
    assert resolved.plan.plan_id == "free"


def test_resolve_entitlements_uses_supplied_usage_port():
    class _FakePort:
        async def usage_for_period(self, user_id, *, period_start, period_end):
            assert user_id == 7
            return UsageSnapshot(meetings_used=1, minutes_used=42)

    now = datetime(2026, 9, 15, tzinfo=UTC)
    resolved = asyncio.run(resolve_entitlements({}, now, user_id=7, usage_port=_FakePort()))
    assert resolved.usage == UsageSnapshot(meetings_used=1, minutes_used=42)


# ── DB-77 admin overrides ────────────────────────────────────────────────────────────────────────


def test_plan_override_wins_over_active_stripe_tier():
    """A Pro subscriber comped to Team by support resolves to Team, not their paid tier."""
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {
        "subscription_status": "active",
        "subscription_tier": "pro",
        "plan_override": "team",
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "team"
    assert plan.limits.concurrent_bots == 5
    assert plan.plan_override == "team"
    # Overriding the PLAN never invents a subscription — status/period stay Stripe's.
    assert plan.status == "active"


def test_plan_override_wins_over_free_with_no_subscription():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    plan = resolve_plan({"plan_override": "pro"}, now)
    assert plan.plan_id == "pro"
    assert plan.limits.meetings_per_month is None
    assert plan.plan_override == "pro"


def test_clearing_plan_override_falls_back_to_stripe_tier():
    """`plan_override: None` (or the key simply absent) is "no override" — the Stripe-derived
    tier decides alone, matching a support agent clearing a comp."""
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {"subscription_status": "active", "subscription_tier": "pro", "plan_override": None}
    plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"
    assert plan.plan_override is None


def test_unrecognized_plan_override_is_ignored_and_logged(caplog):
    """A stale override naming a retired catalog plan id is logged and ignored — same posture as
    an unrecognized `subscription_tier` — never crashes spawn-time resolution."""
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {"subscription_status": "active", "subscription_tier": "pro", "plan_override": "enterprise"}
    with caplog.at_level("WARNING"):
        plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"  # the Stripe tier still decides
    assert plan.unrecognized_plan_override == "enterprise"
    assert any("unrecognized plan_override" in r.message for r in caplog.records)


def test_unknown_tier_and_override_together_override_still_wins():
    """A garbage `subscription_tier` (DB-70's "unrecognized tier" case) alongside a VALID
    `plan_override` — the override still wins; the resolver never lets a garbage Stripe field
    block a real admin comp."""
    now = datetime(2026, 9, 15, tzinfo=UTC)
    data = {
        "subscription_status": "active",
        "subscription_tier": "not-a-real-plan",
        "plan_override": "team",
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "team"
    assert plan.unrecognized_tier == "not-a-real-plan"
    assert plan.plan_override == "team"


def test_quota_bonus_applied_when_period_matches():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    period_start = datetime(2026, 9, 1, tzinfo=UTC)  # the free plan's calendar-month start
    data = {"quota_bonus": 2, "quota_bonus_period_start": _unix(period_start)}
    plan = resolve_plan(data, now)
    assert plan.plan_id == "free"
    assert plan.limits.meetings_per_month == 1 + 2
    assert plan.quota_bonus_applied == 2


def test_quota_bonus_does_not_carry_over_to_a_new_period():
    """A bonus stamped for August does not silently apply once September's calendar month
    starts — the exact "does it reset per period" behavior DB-77 must decide and document."""
    now = datetime(2026, 9, 15, tzinfo=UTC)
    august_start = datetime(2026, 8, 1, tzinfo=UTC)
    data = {"quota_bonus": 2, "quota_bonus_period_start": _unix(august_start)}
    plan = resolve_plan(data, now)
    assert plan.plan_id == "free"
    assert plan.limits.meetings_per_month == 1  # unchanged — the bonus targeted a period that ended
    assert plan.quota_bonus_applied == 0


def test_quota_bonus_irrelevant_when_plan_is_unlimited():
    now = datetime(2026, 9, 15, tzinfo=UTC)
    period_start = datetime(2026, 9, 1, tzinfo=UTC)
    data = {
        "subscription_status": "active",
        "subscription_tier": "pro",
        "quota_bonus": 5,
        "quota_bonus_period_start": _unix(period_start),
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "pro"
    assert plan.limits.meetings_per_month is None  # still UNLIMITED, never a large int
    assert plan.quota_bonus_applied == 0


def test_quota_bonus_combines_with_plan_override():
    """Support comps BOTH a plan bump and a bonus meeting in the same patch — both apply, since
    the override is resolved first and the bonus is added to whatever plan results."""
    now = datetime(2026, 9, 15, tzinfo=UTC)
    period_start = datetime(2026, 9, 1, tzinfo=UTC)
    data = {
        "plan_override": "free",
        "quota_bonus": 3,
        "quota_bonus_period_start": _unix(period_start),
    }
    plan = resolve_plan(data, now)
    assert plan.plan_id == "free"
    assert plan.limits.meetings_per_month == 1 + 3
    assert plan.plan_override == "free"
    assert plan.quota_bonus_applied == 3
