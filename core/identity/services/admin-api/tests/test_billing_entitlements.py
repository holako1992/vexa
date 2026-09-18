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
