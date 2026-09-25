"""The Stripe edge (DB-73) — signature verification + the REST calls checkout/portal/webhook need.

NO STRIPE SDK. Stripe's REST API is form-encoded POSTs behind a bearer key, and the webhook
signature check is ~20 lines of stdlib `hmac` — both comfortably inside "no new dependency"
(AGENTS.md P18: Category A only, and simpler still to have none). `httpx` is already a dependency
everywhere else in this codebase (`app/events.py`'s flows publisher); this module reuses it rather
than adding `stripe` (MIT, but a second HTTP client and a second retry/timeout policy for one
integration is not a price worth paying when the wire format is this small).

Two independent pieces, deliberately kept apart:

  * `verify_signature` — PURE, no I/O, no Stripe account needed to test. Stripe signs
    ``"{timestamp}.{raw_body}"`` with HMAC-SHA256 under the webhook secret and sends
    ``Stripe-Signature: t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>...]`` (Stripe rotates webhook
    secrets by sending the payload signed under BOTH the old and new secret for a transition
    window — multiple ``v1`` entries, any one of which may verify). A stale timestamp (default
    tolerance 300s, Stripe's own default) refuses a replayed capture even with a leaked secret.
  * `StripeClient` — the account-side calls (customer, checkout session, portal session,
    subscription). Takes an OPTIONAL ``httpx.MockTransport`` so tests never touch the network
    (D-book: prove the request SHAPE, not a live Stripe account).
"""
from __future__ import annotations

import hmac
import logging
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Dict, List, Optional, Sequence

import httpx

log = logging.getLogger("admin_api.billing.stripe_gateway")

DEFAULT_API_BASE = "https://api.stripe.com/v1"
#: Stripe's own default tolerance for `construct_event` — reject anything older (a captured POST
#: replayed later) or, doubtfully, from the future (clock skew beyond this is itself a signal).
DEFAULT_TOLERANCE_S = 300


class StripeSignatureError(Exception):
    """The `Stripe-Signature` header did not verify — `reason` names EXACTLY why (missing header,
    unparseable, no v1 entry matched, or the timestamp fell outside tolerance) so the 400 the
    webhook route answers with is actionable rather than a bare 'invalid signature'."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _parse_signature_header(header: str) -> tuple[Optional[int], List[str]]:
    """`"t=169...,v1=abc...,v1=def..."` -> `(1690000000, ["abc...", "def..."])`. Unknown schemes
    (Stripe reserves `v0` etc. for future signing schemes) are ignored, not refused — a header
    this parser cannot fully classify still yields whatever `v1` entries it does carry."""
    timestamp: Optional[int] = None
    v1_values: List[str] = []
    for part in header.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, _, value = part.partition("=")
        key = key.strip()
        value = value.strip()
        if key == "t":
            try:
                timestamp = int(value)
            except ValueError:
                timestamp = None
        elif key == "v1":
            v1_values.append(value)
    return timestamp, v1_values


def verify_signature(
    payload: bytes,
    signature_header: Optional[str],
    secret: str,
    *,
    tolerance_s: int = DEFAULT_TOLERANCE_S,
    now: Optional[float] = None,
) -> None:
    """Verify a Stripe webhook delivery, or raise `StripeSignatureError` naming why.

    `payload` MUST be the exact raw request body bytes — signing is over the byte string Stripe
    sent, and re-serializing a parsed JSON object (key order, whitespace, unicode escaping can all
    change) would make a genuine delivery fail to verify. Callers read the body with FastAPI's
    `await request.body()` before any JSON parsing, never `request.json()` first.

    Returns `None` on success (raises on every failure) so a caller cannot forget to check a
    boolean — the same "loud failure" shape `config_preflight.ConfigError` uses.
    """
    if not signature_header:
        raise StripeSignatureError("missing Stripe-Signature header")
    if not secret:
        raise StripeSignatureError("no webhook secret configured to verify against")
    timestamp, v1_values = _parse_signature_header(signature_header)
    if timestamp is None:
        raise StripeSignatureError("Stripe-Signature header carries no valid timestamp (t=)")
    if not v1_values:
        raise StripeSignatureError("Stripe-Signature header carries no v1 signature")

    signed_payload = f"{timestamp}.".encode() + payload
    expected = hmac.new(secret.encode(), signed_payload, sha256).hexdigest()
    # Constant-time compare against EVERY v1 entry (Stripe's own secret-rotation window sends the
    # payload signed under both the old and the new secret) — any one match verifies the delivery.
    if not any(hmac.compare_digest(expected, candidate) for candidate in v1_values):
        raise StripeSignatureError("no v1 signature matched the configured webhook secret")

    now_ts = time.time() if now is None else now
    if abs(now_ts - timestamp) > tolerance_s:
        raise StripeSignatureError(
            f"timestamp {timestamp} is outside the {tolerance_s}s tolerance (now={now_ts:.0f}) "
            "— stale or replayed delivery"
        )


# ── form encoding: Stripe's API takes PHP-style bracket notation for nested/array params ────────

def _flatten_form(params: Dict[str, Any], prefix: str = "") -> Dict[str, str]:
    """`{"line_items": [{"price": "p1", "quantity": 1}]}` ->
    `{"line_items[0][price]": "p1", "line_items[0][quantity]": "1"}` — the form-encoding shape
    Stripe's REST API expects for a nested/array field (there is no JSON body mode for this API)."""
    out: Dict[str, str] = {}
    if isinstance(params, dict):
        for key, value in params.items():
            key_path = f"{prefix}[{key}]" if prefix else str(key)
            out.update(_flatten_form(value, key_path))
    elif isinstance(params, (list, tuple)):
        for i, value in enumerate(params):
            out.update(_flatten_form(value, f"{prefix}[{i}]"))
    elif params is None:
        pass  # omitted, never sent as the literal string "None"
    elif isinstance(params, bool):
        out[prefix] = "true" if params else "false"
    else:
        out[prefix] = str(params)
    return out


@dataclass
class StripeClient:
    """The account-side Stripe REST calls checkout/portal/the webhook handler need.

    ``transport`` is an injectable ``httpx.BaseTransport`` (tests pass an ``httpx.MockTransport``
    so nothing here ever touches the real network — see `tests/test_billing_stripe_checkout_portal.py`).
    """

    secret_key: str
    base_url: str = DEFAULT_API_BASE
    timeout: float = 10.0
    transport: Optional[httpx.BaseTransport] = None

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self.timeout,
            transport=self.transport,
            headers={"Authorization": f"Bearer {self.secret_key}"},
        )

    async def _post(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        async with self._client() as client:
            r = await client.post(path, data=_flatten_form(params))
        r.raise_for_status()
        return r.json()

    async def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        async with self._client() as client:
            r = await client.get(path, params=_flatten_form(params or {}))
        r.raise_for_status()
        return r.json()

    async def create_customer(self, *, email: str, metadata: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """`POST /v1/customers` — called once, the first time a user checks out or opens the
        portal with no `stripe_customer_id` stored yet."""
        return await self._post("/customers", {"email": email, "metadata": metadata or {}})

    async def create_checkout_session(
        self,
        *,
        customer_id: str,
        price_id: str,
        success_url: str,
        cancel_url: str,
        client_reference_id: str,
        metadata: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """`POST /v1/checkout/sessions`, `mode=subscription` — always: DB-73 sells subscriptions,
        never a one-off charge. `client_reference_id` carries OUR user id, so
        `checkout.session.completed` can resolve the session back to a user without a second
        lookup table (Stripe echoes it verbatim on the event)."""
        return await self._post(
            "/checkout/sessions",
            {
                "mode": "subscription",
                "customer": customer_id,
                "client_reference_id": client_reference_id,
                "success_url": success_url,
                "cancel_url": cancel_url,
                "line_items": [{"price": price_id, "quantity": 1}],
                "metadata": metadata or {},
            },
        )

    async def create_portal_session(self, *, customer_id: str, return_url: str) -> Dict[str, Any]:
        """`POST /v1/billing_portal/sessions` — card changes, cancellation, invoices; Stripe hosts
        the whole surface, so this service never renders payment UI (P14-adjacent: no card data
        ever reaches our request path)."""
        return await self._post(
            "/billing_portal/sessions", {"customer": customer_id, "return_url": return_url}
        )

    async def get_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """`GET /v1/subscriptions/{id}` — THE re-read the webhook handler's idempotent-by-design
        model depends on: every subscription-affecting event re-fetches this rather than trusting
        the event body, so redelivery and reordering both converge on the same written state (see
        `billing/stripe_webhook.py` module docstring)."""
        return await self._get(f"/subscriptions/{subscription_id}")
