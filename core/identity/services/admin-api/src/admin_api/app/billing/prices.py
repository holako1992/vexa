"""The prices this deployment sells, as Stripe states them — for display on the billing page.

Stripe is the one owner of what a plan costs: the catalog maps `(plan, interval)` to a price id
(`catalog.STRIPE_PRICE_ENV`), and this module reads that price back from Stripe — amount,
currency, interval — so the figure a person sees before Checkout is the figure Checkout charges.
Nothing here stores or hardcodes an amount.

A price Stripe will not return, or one whose own interval disagrees with the env var it was
configured under (a yearly price pasted into `STRIPE_PRICE_PRO_MONTHLY`), is logged and left out:
the page then shows that plan without a figure rather than a wrong one. A complete read is cached
for `CACHE_TTL_S`; an incomplete one is not, so a transient Stripe failure heals on the next call.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

from . import catalog
from .stripe_gateway import StripeAPIError

log = logging.getLogger("admin_api.billing.prices")

#: How long a complete read is served without asking Stripe again. A price edited in Stripe shows
#: on the billing page within this window.
CACHE_TTL_S = 300.0


@dataclass(frozen=True)
class PlanPrice:
    plan: str
    interval: str
    #: Minor units (cents), exactly as Stripe's `unit_amount`.
    unit_amount: int
    currency: str


_cache: Dict[str, Any] = {"key": None, "at": 0.0, "prices": []}


def clear_cache() -> None:
    _cache.update(key=None, at=0.0, prices=[])


def _plan_price(plan: str, interval: str, price_id: str, body: Dict[str, Any]) -> Optional[PlanPrice]:
    """`body` (a Stripe Price object) as a `PlanPrice`, or `None` when it cannot honestly be shown
    as `(plan, interval)`."""
    unit_amount = body.get("unit_amount")
    currency = body.get("currency")
    stripe_interval = (body.get("recurring") or {}).get("interval")
    if not isinstance(unit_amount, int) or not isinstance(currency, str) or not currency:
        log.warning("stripe price %s for %s/%s has no fixed amount; not shown", price_id, plan, interval)
        return None
    if stripe_interval != interval:
        log.warning(
            "stripe price %s is configured as %s/%s but bills every %s; not shown",
            price_id, plan, interval, stripe_interval,
        )
        return None
    if body.get("active") is False:
        log.warning("stripe price %s for %s/%s is archived; not shown", price_id, plan, interval)
        return None
    return PlanPrice(plan=plan, interval=interval, unit_amount=unit_amount, currency=currency.lower())


async def configured_prices(
    client: Any,
    env: Optional[Dict[str, str]] = None,
    *,
    clock: Callable[[], float] = time.monotonic,
) -> List[PlanPrice]:
    """Every configured `(plan, interval)` price Stripe confirms, in catalog order."""
    configured: List[Tuple[str, str, str]] = []
    for plan, interval in catalog.STRIPE_PRICE_ENV:
        price_id = catalog.price_id_for(plan, interval, env)
        if price_id:
            configured.append((plan, interval, price_id))
    key = tuple(configured)
    if _cache["key"] == key and clock() - _cache["at"] < CACHE_TTL_S:
        return list(_cache["prices"])

    prices: List[PlanPrice] = []
    complete = True
    for plan, interval, price_id in configured:
        try:
            body = await client.get_price(price_id)
        except StripeAPIError as exc:
            log.warning("stripe refused price %s for %s/%s: %s", price_id, plan, interval, exc.message)
            complete = False
            continue
        except httpx.HTTPError as exc:
            log.warning("stripe unreachable reading price %s for %s/%s: %s", price_id, plan, interval, exc)
            complete = False
            continue
        price = _plan_price(plan, interval, price_id, body)
        if price is not None:
            prices.append(price)

    if complete:
        _cache.update(key=key, at=clock(), prices=list(prices))
    return prices
