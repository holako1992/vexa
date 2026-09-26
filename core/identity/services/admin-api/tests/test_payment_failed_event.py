"""`payment.failed` (DB-78) — the fact identity's Stripe webhook hands to flows, IN ADDITION to
`subscription.changed`, ONLY for `invoice.payment_failed`. Pure — `events_mod.payment_failed_*`
takes no DB and no clock, so this suite needs no docker (unlike the endpoint suites) and runs
under a bare `pytest`.

THE ONE PROPERTY THAT MATTERS: the fact's id is keyed to the INVOICE, not the Stripe event id —
see `payment_failed_source_id`'s own docstring for why. `test_billing_stripe_webhook_endpoint.py`
covers the wire-level idempotency (redelivery/retry through the actual `/billing/webhook` route);
this file pins the pure building block that makes it true.
"""
from __future__ import annotations

from admin_api.app import events as events_mod


def test_source_id_is_keyed_to_the_invoice_not_the_event():
    a = events_mod.payment_failed_source_id(42, "in_123")
    b = events_mod.payment_failed_source_id(42, "in_123")
    assert a == b


def test_a_different_invoice_for_the_same_subject_is_a_different_fact():
    a = events_mod.payment_failed_source_id(42, "in_123")
    b = events_mod.payment_failed_source_id(42, "in_456")
    assert a != b


def test_the_same_invoice_for_a_different_subject_is_a_different_fact():
    a = events_mod.payment_failed_source_id(42, "in_123")
    b = events_mod.payment_failed_source_id(7, "in_123")
    assert a != b


def test_refs_carry_subject_and_invoice_id_and_nothing_that_looks_like_a_price():
    refs = events_mod.payment_failed_refs(42, "in_123")
    assert refs == {"subject": "42", "invoice_id": "in_123"}
    assert all("price" not in k and "amount" not in k for k in refs)


def test_refs_tolerate_a_missing_invoice_id():
    refs = events_mod.payment_failed_refs(42, None)
    assert refs == {"subject": "42", "invoice_id": ""}


def test_event_type_constant_matches_the_wire_spelling():
    assert events_mod.EVENT_PAYMENT_FAILED == "payment.failed"
