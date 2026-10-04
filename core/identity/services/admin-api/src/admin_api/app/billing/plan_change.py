"""Switching a subscriber between catalog plans — one subscription per customer, changed in place.

A customer holds at most ONE live Stripe subscription; checkout refuses a second
(`live_subscriptions`), and a switch rewrites the one they have. The rules for WHEN a switch takes
effect and what it costs:

  * **Upgrade, same interval** (Pro → Team, both monthly): the new plan applies now; the price on
    the subscription changes with no proration, so nothing is charged now and the next renewal
    bills the new price.
  * **Downgrade** (Team → Pro), **or any monthly ↔ yearly switch**: the subscription keeps what it
    has until the paid period ends, then moves to the target. Stripe holds that as a subscription
    schedule: phase 0 is the rest of the current period, phase 1 is the target for one interval,
    after which the schedule releases the subscription to renew on the target as usual. (Stripe
    cannot change a subscription's billing interval mid-period without invoicing it at once, so
    an interval switch always waits for the period to end.)
  * **Upgrade that also changes interval** (Pro monthly → Team yearly): both at once — phase 0
    becomes Team at the CURRENT interval (the better plan now, no charge), phase 1 is Team yearly
    from the next renewal.
  * **Back to what the subscription already is**: any pending switch is called off (the schedule
    is released) and nothing else changes.

Cancelling (`cancel_at_period_end`) ends the subscription when its paid period ends, and
`resume` calls that off; a cancelling subscription cannot be switched until it is resumed.

Every call goes through `StripeClient`; the caller re-reads the subscription afterwards and writes
it through the webhook's own `apply_subscription_patch`, so the stored state is Stripe's.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from . import catalog
from .stripe_webhook import _first_item, _price_id

#: Statuses in which a subscription still exists for the customer — billed, or about to be.
LIVE_STATUSES = frozenset({"active", "trialing", "past_due", "unpaid", "incomplete", "paused"})
#: Statuses in which a switch is allowed (the plan is in force).
SWITCHABLE_STATUSES = frozenset({"active", "trialing", "past_due"})
PLAN_RANK = {"pro": 1, "team": 2}


class PlanChangeRefused(Exception):
    """A switch this subscription cannot take, with the reason a person can act on."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PlanChangeResult:
    #: "now" (target applies immediately), "scheduled" (at period end), or "kept" (pending switch
    #: called off; the subscription already was the target).
    effective: str


def live_subscriptions(subscriptions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [s for s in subscriptions if s.get("status") in LIVE_STATUSES]


def current_plan(subscription: Dict[str, Any], env: Optional[Dict[str, str]] = None) -> Optional[Tuple[str, str]]:
    price_id = _price_id(subscription)
    return catalog.plan_for_price_id(price_id, env) if price_id else None


def _schedule(subscription: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    schedule = subscription.get("schedule")
    return schedule if isinstance(schedule, dict) else None


def _price_for(plan: str, interval: str, env: Optional[Dict[str, str]]) -> str:
    price_id = catalog.price_id_for(plan, interval, env)
    if not price_id:
        env_key = catalog.STRIPE_PRICE_ENV.get((plan, interval))
        raise PlanChangeRefused(
            "not_on_sale",
            f"{plan}/{interval} is not on sale on this deployment"
            + (f" — {env_key} is not set" if env_key else ""),
        )
    return price_id


async def change_plan(
    client: Any,
    subscription: Dict[str, Any],
    target_plan: str,
    target_interval: str,
    env: Optional[Dict[str, str]] = None,
) -> PlanChangeResult:
    """Apply the switch to Stripe. `subscription` must be read with its schedule expanded
    (`StripeClient.get_subscription`)."""
    if target_plan not in PLAN_RANK:
        raise PlanChangeRefused("unknown_plan", f"plan must be one of {sorted(PLAN_RANK)}")
    if subscription.get("status") not in SWITCHABLE_STATUSES:
        raise PlanChangeRefused(
            "not_switchable",
            f"This subscription is {subscription.get('status')}; start a new one from the billing page.",
        )
    if subscription.get("cancel_at_period_end"):
        raise PlanChangeRefused(
            "cancelling",
            "This subscription is set to end at the close of the period. Resume it before "
            "switching plans.",
        )
    current = current_plan(subscription, env)
    if current is None:
        raise PlanChangeRefused("unknown_current_plan", "This subscription is on a price this deployment does not sell.")
    cur_plan, cur_interval = current
    schedule = _schedule(subscription)
    sub_id = subscription["id"]

    if (target_plan, target_interval) == (cur_plan, cur_interval):
        if schedule is not None:
            await client.release_schedule(schedule["id"])
        return PlanChangeResult(effective="kept")

    target_price = _price_for(target_plan, target_interval, env)
    upgrade = PLAN_RANK[target_plan] > PLAN_RANK.get(cur_plan, 0)

    if upgrade and target_interval == cur_interval:
        if schedule is not None:
            await client.release_schedule(schedule["id"])
        item_id = _first_item(subscription).get("id")
        await client.update_subscription(sub_id, {
            "items": [{"id": item_id, "price": target_price}],
            "proration_behavior": "none",
        })
        return PlanChangeResult(effective="now")

    now_price = _price_for(target_plan, cur_interval, env) if upgrade else _price_id(subscription)
    if schedule is None:
        schedule = await client.create_schedule_from_subscription(sub_id)
    phase = schedule.get("current_phase") or {}
    if phase.get("start_date") is None or phase.get("end_date") is None:
        raise PlanChangeRefused("no_current_period", "Stripe reported no current billing period for this subscription.")
    await client.update_schedule(schedule["id"], {
        "end_behavior": "release",
        "phases": [
            {
                "items": [{"price": now_price, "quantity": 1}],
                "start_date": phase["start_date"],
                "end_date": phase["end_date"],
                "proration_behavior": "none",
            },
            {
                "items": [{"price": target_price, "quantity": 1}],
                "duration": {"interval": target_interval, "interval_count": 1},
                "proration_behavior": "none",
            },
        ],
    })
    return PlanChangeResult(effective="scheduled")


async def cancel_at_period_end(client: Any, subscription: Dict[str, Any]) -> None:
    """End the subscription when its paid period ends: it stays `active` (with
    `cancel_at_period_end`) until then, and Stripe ends it — and charges nothing more — at that
    point. A pending switch is called off first: Stripe refuses to change the cancellation of a
    subscription a schedule manages, and a plan that is ending has nothing to switch to."""
    if subscription.get("status") not in SWITCHABLE_STATUSES:
        raise PlanChangeRefused("not_cancellable", f"This subscription is {subscription.get('status')}; there is nothing to cancel.")
    if subscription.get("cancel_at_period_end"):
        return
    schedule = _schedule(subscription)
    if schedule is not None:
        await client.release_schedule(schedule["id"])
    await client.update_subscription(subscription["id"], {"cancel_at_period_end": True})


async def resume(client: Any, subscription: Dict[str, Any]) -> None:
    """Call off a cancellation set for the end of the period; the subscription renews as before."""
    if subscription.get("status") not in SWITCHABLE_STATUSES:
        raise PlanChangeRefused("not_resumable", "This subscription has already ended; subscribe again from the billing page.")
    if not subscription.get("cancel_at_period_end"):
        return
    await client.update_subscription(subscription["id"], {"cancel_at_period_end": False})
