"""`billing/prices.py`: the billing page's prices are Stripe's own, read through an
`httpx.MockTransport` — never the network. Pure: no database, no docker."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from admin_api.app.billing import prices
from admin_api.app.billing.prices import PlanPrice, configured_prices
from admin_api.app.billing.stripe_gateway import StripeClient

ENV = {
    "STRIPE_PRICE_PRO_MONTHLY": "price_pro_m",
    "STRIPE_PRICE_PRO_YEARLY": "price_pro_y",
    "STRIPE_PRICE_TEAM_MONTHLY": "price_team_m",
    "STRIPE_PRICE_TEAM_YEARLY": "price_team_y",
}

STRIPE_PRICES = {
    "price_pro_m": {"id": "price_pro_m", "unit_amount": 500, "currency": "usd", "active": True, "recurring": {"interval": "month"}},
    "price_pro_y": {"id": "price_pro_y", "unit_amount": 5000, "currency": "usd", "active": True, "recurring": {"interval": "year"}},
    "price_team_m": {"id": "price_team_m", "unit_amount": 2000, "currency": "usd", "active": True, "recurring": {"interval": "month"}},
    "price_team_y": {"id": "price_team_y", "unit_amount": 10000, "currency": "usd", "active": True, "recurring": {"interval": "year"}},
}


class _Stripe:
    def __init__(self, table):
        self.table = table
        self.calls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        price_id = request.url.path.rsplit("/", 1)[-1]
        self.calls.append(price_id)
        if price_id in self.table:
            return httpx.Response(200, json=self.table[price_id])
        return httpx.Response(404, json={"error": {"message": f"No such price: '{price_id}'"}})

    def client(self) -> StripeClient:
        return StripeClient(secret_key="sk_test_only_1234", transport=httpx.MockTransport(self.handler))


@pytest.fixture(autouse=True)
def _fresh_cache():
    prices.clear_cache()
    yield
    prices.clear_cache()


def _run(stripe: _Stripe, env=ENV, clock=lambda: 0.0):
    return asyncio.run(configured_prices(stripe.client(), env, clock=clock))


def test_every_configured_price_is_read_from_stripe_in_catalog_order():
    stripe = _Stripe(STRIPE_PRICES)
    assert _run(stripe) == [
        PlanPrice("pro", "month", 500, "usd"),
        PlanPrice("pro", "year", 5000, "usd"),
        PlanPrice("team", "month", 2000, "usd"),
        PlanPrice("team", "year", 10000, "usd"),
    ]
    assert stripe.calls == ["price_pro_m", "price_pro_y", "price_team_m", "price_team_y"]


def test_an_unconfigured_plan_is_neither_fetched_nor_listed():
    stripe = _Stripe(STRIPE_PRICES)
    env = {k: v for k, v in ENV.items() if not k.startswith("STRIPE_PRICE_TEAM")}
    assert [(p.plan, p.interval) for p in _run(stripe, env)] == [("pro", "month"), ("pro", "year")]
    assert stripe.calls == ["price_pro_m", "price_pro_y"]


def test_a_price_whose_interval_disagrees_with_its_env_var_is_left_out():
    table = dict(STRIPE_PRICES)
    table["price_pro_m"] = {**table["price_pro_m"], "recurring": {"interval": "year"}}
    assert ("pro", "month") not in [(p.plan, p.interval) for p in _run(_Stripe(table))]


def test_an_archived_or_amountless_price_is_left_out():
    table = dict(STRIPE_PRICES)
    table["price_pro_m"] = {**table["price_pro_m"], "active": False}
    table["price_team_m"] = {**table["price_team_m"], "unit_amount": None}
    assert [(p.plan, p.interval) for p in _run(_Stripe(table))] == [("pro", "year"), ("team", "year")]


def test_a_complete_read_is_cached_until_the_ttl_passes():
    stripe = _Stripe(STRIPE_PRICES)
    _run(stripe, clock=lambda: 0.0)
    _run(stripe, clock=lambda: prices.CACHE_TTL_S - 1)
    assert len(stripe.calls) == 4
    _run(stripe, clock=lambda: prices.CACHE_TTL_S + 1)
    assert len(stripe.calls) == 8


def test_a_read_stripe_refused_is_not_cached():
    table = {k: v for k, v in STRIPE_PRICES.items() if k != "price_team_y"}
    stripe = _Stripe(table)
    assert len(_run(stripe)) == 3
    _run(stripe)
    assert len(stripe.calls) == 8


def test_changing_the_configured_ids_bypasses_the_cache():
    stripe = _Stripe({**STRIPE_PRICES, "price_pro_m2": {**STRIPE_PRICES["price_pro_m"], "unit_amount": 700}})
    _run(stripe)
    found = _run(stripe, {**ENV, "STRIPE_PRICE_PRO_MONTHLY": "price_pro_m2"})
    assert found[0] == PlanPrice("pro", "month", 700, "usd")
