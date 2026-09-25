"""The Stripe webhook's event handling (DB-73) — signature-verified in `stripe_gateway`, wired to
the DB in `main.py`. This module is the part that can be reasoned about and tested without a wire:
what does EACH event type do to `users.data`, given a subscription object.

THE DESIGN: RE-READ, NEVER TRUST THE DELIVERED BODY. Stripe redelivers (at-least-once) and
reorders (no ordering guarantee across event types, and even same-type events can arrive out of
sequence under retry). The chosen shape, per every subscription-affecting event
(`checkout.session.completed`, `customer.subscription.created|updated|deleted`,
`invoice.payment_failed|paid`): resolve which Stripe SUBSCRIPTION the event concerns, then
`StripeClient.get_subscription` to fetch its state AS OF RIGHT NOW from the Stripe API, and write
THAT. The event body itself is used only to find the subscription id and the user (customer id /
client_reference_id) — never for the fields that actually get written.

This makes the result a PURE FUNCTION OF STRIPE'S CURRENT STATE, independent of delivery order or
count:

  * redelivery — the same event arrives twice, is fetched twice, resolves to the same subscription
    state twice, writes the same fields twice. The second write is a no-op in every sense a caller
    can observe (byte-identical `users.data`), with no ledger of already-seen event ids needed.
  * reordering — `customer.subscription.updated` (now stale) arrives AFTER
    `customer.subscription.deleted` (now current). Both re-fetch the SAME subscription id from
    Stripe and get the SAME answer (canceled), so whichever is processed last writes the same
    thing the other did. Trusting each event's own embedded object would instead let the stale
    `updated` event un-cancel a subscription that Stripe has already deleted.

An event-id ledger (the alternative design) would make redelivery a no-op by skipping a seen id,
but does NOTHING for reordering — two DIFFERENT event ids racing to write two DIFFERENT snapshots
still resolve by "whichever request's UPDATE commits last wins", which is exactly the ordering bug
above. Re-read-and-write is strictly stronger and needs no extra state, which is why it is the one
this module implements. See `tests/test_billing_stripe_webhook.py` for both scenarios exercised.

`apply_subscription_patch` is the pure core (subscription dict in, `PlatformBillingDataPatch`-shaped
dict out, or `None` when the price does not resolve to a catalog plan) — no I/O, no clock read
beyond what `subscription` already carries, so DB-73's acceptance table is a table of
`apply_subscription_patch(subscription) == expected` assertions.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .catalog import plan_for_price_id

log = logging.getLogger("admin_api.billing.stripe_webhook")

#: Stripe event types this webhook acts on. Every one of them is handled by the SAME
#: subscription-affecting path (`main.py`'s webhook route): resolve the subscription id, re-read
#: it, apply. Anything else (payment_method.*, customer.updated, ...) is acknowledged 200 and
#: otherwise ignored — DB-73 does not need it, and acknowledging keeps Stripe from retrying.
HANDLED_EVENT_TYPES = frozenset(
    {
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "invoice.payment_failed",
        "invoice.paid",
    }
)


def _first_item(subscription: Dict[str, Any]) -> Dict[str, Any]:
    items = ((subscription.get("items") or {}).get("data")) or []
    return items[0] if items else {}


def _price_id(subscription: Dict[str, Any]) -> Optional[str]:
    item = _first_item(subscription)
    price = item.get("price") or {}
    return price.get("id")


def _period_bound(subscription: Dict[str, Any], field: str) -> Optional[int]:
    """Stripe has carried `current_period_start`/`_end` at the TOP LEVEL of the subscription
    object since the API's beginning; newer API versions additionally (and, on some versions,
    ONLY) carry it per subscription ITEM. Read both, top level first, so this module works
    whichever API version the configured `STRIPE_SECRET_KEY`'s account defaults to — a shape this
    service does not control and must not assume."""
    value = subscription.get(field)
    if value is None:
        value = _first_item(subscription).get(field)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def apply_subscription_patch(subscription: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A Stripe subscription object (as `StripeClient.get_subscription` returns it) -> the
    `PlatformBillingDataPatch`-shaped dict to write onto `users.data`, or `None` when the
    subscription's price does not resolve to a catalog plan (`catalog.plan_for_price_id`) — an
    unrecognized price is LOGGED AND IGNORED, never guessed (AGENTS.md: never invent a price
    outside `billing/catalog.py`). `None` means "write nothing for this event", not "write free" —
    the existing stored plan is left exactly as it was.
    """
    price_id = _price_id(subscription)
    resolved = plan_for_price_id(price_id) if price_id else None
    if resolved is None:
        log.warning(
            "billing.stripe_webhook: subscription %r carries unrecognized price %r — ignoring "
            "(no catalog plan maps to it; users.data is left unchanged)",
            subscription.get("id"), price_id,
        )
        return None
    plan_id, _interval = resolved

    patch: Dict[str, Any] = {
        "stripe_subscription_id": subscription.get("id"),
        "subscription_status": subscription.get("status"),
        "subscription_tier": plan_id,
        "subscription_cancel_at_period_end": bool(subscription.get("cancel_at_period_end") or False),
    }
    period_start = _period_bound(subscription, "current_period_start")
    period_end = _period_bound(subscription, "current_period_end")
    if period_start is not None:
        patch["subscription_current_period_start"] = period_start
    if period_end is not None:
        patch["subscription_current_period_end"] = period_end
    canceled_at = subscription.get("canceled_at")
    if canceled_at is not None:
        try:
            patch["subscription_cancellation_date"] = int(canceled_at)
        except (TypeError, ValueError):
            pass
    return patch


def subscription_id_for_event(event_type: str, event_object: Dict[str, Any]) -> Optional[str]:
    """Which Stripe subscription id THIS event concerns — the one id `main.py`'s handler re-reads
    via `StripeClient.get_subscription`, per the module's re-read design. `None` means the event
    carries no subscription (a Checkout Session in a mode other than `subscription`, or an invoice
    with no subscription attached) and is acknowledged without writing anything."""
    if event_type == "checkout.session.completed":
        sub = event_object.get("subscription")
        return sub if isinstance(sub, str) else None
    if event_type.startswith("customer.subscription."):
        sub_id = event_object.get("id")
        return sub_id if isinstance(sub_id, str) else None
    if event_type.startswith("invoice."):
        sub = event_object.get("subscription")
        return sub if isinstance(sub, str) else None
    return None


def customer_id_for_event(event_object: Dict[str, Any]) -> Optional[str]:
    """The Stripe customer id an event's object names — used to locate the user when the event is
    NOT `checkout.session.completed` (which instead carries `client_reference_id`, our own id)."""
    customer = event_object.get("customer")
    return customer if isinstance(customer, str) else None


def client_reference_id_for_event(event_type: str, event_object: Dict[str, Any]) -> Optional[str]:
    if event_type != "checkout.session.completed":
        return None
    ref = event_object.get("client_reference_id")
    return ref if isinstance(ref, str) and ref else None
