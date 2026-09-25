"""DB-73 — `billing.stripe_gateway.verify_signature`: the ONE gate `POST /billing/webhook` stands
behind (Stripe cannot present an X-API-Key, so signature verification IS the authentication).

No docker: pure `hmac` over bytes, no DB, no network — mirrors `test_billing_catalog.py`'s "no
docker" framing for the same reason.
"""
from __future__ import annotations

import hashlib
import hmac
import time

import pytest

from admin_api.app.billing.stripe_gateway import StripeSignatureError, verify_signature

SECRET = "whsec_test_only_1234567890abcdef"  # TEST VALUE — never a real Stripe secret (AGENTS.md)
PAYLOAD = b'{"id": "evt_test_1", "type": "customer.subscription.updated"}'


def _sign(payload: bytes, secret: str, timestamp: int) -> str:
    """Build a genuine `Stripe-Signature` header the way Stripe's own signer does, so the test
    fixture and the code under test can never silently agree on a DIFFERENT algorithm."""
    signed_payload = f"{timestamp}.".encode() + payload
    v1 = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={v1}"


def test_a_genuine_signature_verifies():
    now = time.time()
    header = _sign(PAYLOAD, SECRET, int(now))
    verify_signature(PAYLOAD, header, SECRET, now=now)  # raises on failure — no return to check


def test_a_tampered_body_fails():
    """The header was computed over the ORIGINAL body; a single byte changed after signing must
    not verify — this is the whole point of a signature."""
    now = time.time()
    header = _sign(PAYLOAD, SECRET, int(now))
    tampered = PAYLOAD.replace(b"evt_test_1", b"evt_test_2")
    with pytest.raises(StripeSignatureError, match="no v1 signature matched"):
        verify_signature(tampered, header, SECRET, now=now)


def test_the_wrong_secret_fails():
    """A signature genuinely computed, but under a DIFFERENT secret than the one this deployment
    has configured — the shape of a delivery meant for someone else's endpoint, or a leaked-but-
    since-rotated secret."""
    now = time.time()
    header = _sign(PAYLOAD, "whsec_a_completely_different_secret", int(now))
    with pytest.raises(StripeSignatureError, match="no v1 signature matched"):
        verify_signature(PAYLOAD, header, SECRET, now=now)


def test_a_stale_timestamp_fails():
    """A genuinely signed payload, replayed well outside the tolerance window — the captured-POST
    replay this tolerance exists to refuse even when the secret itself is not compromised."""
    now = time.time()
    ten_minutes_ago = now - 600
    header = _sign(PAYLOAD, SECRET, int(ten_minutes_ago))
    with pytest.raises(StripeSignatureError, match="outside the .* tolerance"):
        verify_signature(PAYLOAD, header, SECRET, now=now, tolerance_s=300)


def test_a_future_timestamp_beyond_tolerance_also_fails():
    """Symmetric: `abs()` refuses a clock-skewed-into-the-future delivery too, not only a stale one."""
    now = time.time()
    header = _sign(PAYLOAD, SECRET, int(now + 600))
    with pytest.raises(StripeSignatureError, match="outside the .* tolerance"):
        verify_signature(PAYLOAD, header, SECRET, now=now, tolerance_s=300)


def test_a_missing_header_fails():
    with pytest.raises(StripeSignatureError, match="missing Stripe-Signature"):
        verify_signature(PAYLOAD, None, SECRET)
    with pytest.raises(StripeSignatureError, match="missing Stripe-Signature"):
        verify_signature(PAYLOAD, "", SECRET)


def test_no_configured_secret_fails_closed():
    """`STRIPE_WEBHOOK_SECRET` unset must never verify ANY delivery — that would make signature
    verification silently optional exactly when it matters most."""
    now = time.time()
    header = _sign(PAYLOAD, SECRET, int(now))
    with pytest.raises(StripeSignatureError, match="no webhook secret configured"):
        verify_signature(PAYLOAD, header, "", now=now)


def test_a_header_with_no_timestamp_fails():
    with pytest.raises(StripeSignatureError, match="no valid timestamp"):
        verify_signature(PAYLOAD, "v1=abcdef", SECRET)


def test_a_header_with_no_v1_entry_fails():
    with pytest.raises(StripeSignatureError, match="no v1 signature"):
        verify_signature(PAYLOAD, f"t={int(time.time())}", SECRET)


def test_secret_rotation_accepts_either_of_two_v1_entries():
    """Stripe sends a payload signed under BOTH the old and new secret during a rotation window —
    a header carrying two `v1=` entries, either of which must verify."""
    now = time.time()
    ts = int(now)
    old_secret, new_secret = SECRET, "whsec_the_new_one_after_rotation"
    signed_payload = f"{ts}.".encode() + PAYLOAD
    v1_old = hmac.new(old_secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    v1_new = hmac.new(new_secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    header = f"t={ts},v1={v1_old},v1={v1_new}"
    # Verifying against the OLD secret still succeeds because its v1 entry is present.
    verify_signature(PAYLOAD, header, old_secret, now=now)
    # And against the NEW secret too — same header, the other v1 entry matches.
    verify_signature(PAYLOAD, header, new_secret, now=now)
