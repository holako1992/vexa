"""`billing/plan_change.py`: which Stripe calls each kind of switch makes. A fake client records
the calls; no network, no database, no docker."""
from __future__ import annotations

import asyncio

import pytest

from admin_api.app.billing.plan_change import (
    PlanChangeRefused,
    change_plan,
    live_subscriptions,
)

ENV = {
    "STRIPE_PRICE_PRO_MONTHLY": "price_pro_m",
    "STRIPE_PRICE_PRO_YEARLY": "price_pro_y",
    "STRIPE_PRICE_TEAM_MONTHLY": "price_team_m",
    "STRIPE_PRICE_TEAM_YEARLY": "price_team_y",
}
PERIOD = {"start_date": 1_790_000_000, "end_date": 1_792_600_000}


class _FakeStripe:
    def __init__(self):
        self.calls: list[tuple] = []

    async def update_subscription(self, sub_id, params):
        self.calls.append(("update_subscription", sub_id, params))
        return {}

    async def create_schedule_from_subscription(self, sub_id):
        self.calls.append(("create_schedule", sub_id))
        return {"id": "sub_sched_new", "current_phase": dict(PERIOD)}

    async def update_schedule(self, sched_id, params):
        self.calls.append(("update_schedule", sched_id, params))
        return {}

    async def release_schedule(self, sched_id):
        self.calls.append(("release_schedule", sched_id))
        return {}


def _sub(price="price_pro_m", status="active", schedule=None, cancel_at_period_end=False):
    return {
        "id": "sub_1", "status": status, "cancel_at_period_end": cancel_at_period_end,
        "items": {"data": [{"id": "si_1", "price": {"id": price}}]},
        "schedule": schedule,
    }


def _run(sub, plan, interval):
    stripe = _FakeStripe()
    result = asyncio.run(change_plan(stripe, sub, plan, interval, ENV))
    return result.effective, stripe.calls


def _phases(call):
    assert call[0] == "update_schedule"
    return [(p["items"][0]["price"], p.get("start_date"), p.get("end_date"), p.get("duration"))
            for p in call[2]["phases"]]


def test_upgrade_on_the_same_interval_swaps_the_price_now_with_no_proration():
    effective, calls = _run(_sub("price_pro_m"), "team", "month")
    assert effective == "now"
    assert calls == [("update_subscription", "sub_1", {
        "items": [{"id": "si_1", "price": "price_team_m"}], "proration_behavior": "none",
    })]


def test_downgrade_waits_for_the_period_end_on_a_new_schedule():
    effective, calls = _run(_sub("price_team_m"), "pro", "month")
    assert effective == "scheduled"
    assert calls[0] == ("create_schedule", "sub_1")
    assert _phases(calls[1]) == [
        ("price_team_m", PERIOD["start_date"], PERIOD["end_date"], None),
        ("price_pro_m", None, None, {"interval": "month", "interval_count": 1}),
    ]
    assert calls[1][2]["end_behavior"] == "release"
    assert all(p["proration_behavior"] == "none" for p in calls[1][2]["phases"])


def test_monthly_to_yearly_on_the_same_plan_waits_for_the_period_end():
    effective, calls = _run(_sub("price_pro_m"), "pro", "year")
    assert effective == "scheduled"
    assert _phases(calls[1]) == [
        ("price_pro_m", PERIOD["start_date"], PERIOD["end_date"], None),
        ("price_pro_y", None, None, {"interval": "year", "interval_count": 1}),
    ]


def test_upgrade_with_an_interval_change_gives_the_better_plan_now_and_the_new_interval_later():
    effective, calls = _run(_sub("price_pro_m"), "team", "year")
    assert effective == "scheduled"
    assert _phases(calls[1]) == [
        ("price_team_m", PERIOD["start_date"], PERIOD["end_date"], None),
        ("price_team_y", None, None, {"interval": "year", "interval_count": 1}),
    ]


def test_an_existing_schedule_is_rewritten_not_duplicated():
    sched = {"id": "sub_sched_old", "current_phase": dict(PERIOD)}
    effective, calls = _run(_sub("price_team_m", schedule=sched), "pro", "year")
    assert effective == "scheduled"
    assert [c[0] for c in calls] == ["update_schedule"]
    assert calls[0][1] == "sub_sched_old"


def test_an_upgrade_now_calls_off_a_pending_switch_first():
    sched = {"id": "sub_sched_old", "current_phase": dict(PERIOD)}
    effective, calls = _run(_sub("price_pro_m", schedule=sched), "team", "month")
    assert effective == "now"
    assert [c[0] for c in calls] == ["release_schedule", "update_subscription"]


def test_choosing_the_current_plan_calls_off_a_pending_switch():
    sched = {"id": "sub_sched_old", "current_phase": dict(PERIOD)}
    effective, calls = _run(_sub("price_team_m", schedule=sched), "team", "month")
    assert effective == "kept"
    assert calls == [("release_schedule", "sub_sched_old")]


def test_choosing_the_current_plan_with_nothing_pending_does_nothing():
    effective, calls = _run(_sub("price_team_m"), "team", "month")
    assert (effective, calls) == ("kept", [])


@pytest.mark.parametrize("sub,code", [
    (_sub(status="canceled"), "not_switchable"),
    (_sub(status="incomplete"), "not_switchable"),
    (_sub(cancel_at_period_end=True), "cancelling"),
    (_sub(price="price_unknown"), "unknown_current_plan"),
])
def test_a_switch_this_subscription_cannot_take_is_refused_before_any_call(sub, code):
    stripe = _FakeStripe()
    with pytest.raises(PlanChangeRefused) as exc:
        asyncio.run(change_plan(stripe, sub, "team", "month", ENV))
    assert exc.value.code == code
    assert stripe.calls == []


def test_a_target_this_deployment_does_not_sell_is_refused():
    env = {k: v for k, v in ENV.items() if k != "STRIPE_PRICE_TEAM_YEARLY"}
    stripe = _FakeStripe()
    with pytest.raises(PlanChangeRefused) as exc:
        asyncio.run(change_plan(stripe, _sub("price_pro_m"), "team", "year", env))
    assert exc.value.code == "not_on_sale"
    assert stripe.calls == []


def test_only_subscriptions_that_still_exist_count_as_live():
    subs = [{"status": s} for s in ("active", "canceled", "incomplete_expired", "past_due", "trialing")]
    assert [s["status"] for s in live_subscriptions(subs)] == ["active", "past_due", "trialing"]
