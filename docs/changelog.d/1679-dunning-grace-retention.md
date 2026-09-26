- **Dunning mail and Free-plan retention purge (DB-78, #1679).** A failed Stripe invoice
  (`invoice.payment_failed`) already moved a subscription to `past_due` with a 7-day grace
  window (`resolve_plan`'s `grace_until`, DB-70/DB-73) — the paid plan holds through grace, Free
  limits apply after it, and nobody's data was ever touched. This adds the one thing that fact
  was missing: **one email** per failed invoice, through the flows mailbox, linking to
  `/billing`; idempotent on the invoice (not the Stripe event id), so a redelivered webhook event
  or a Stripe retry of the same unpaid invoice sends no second mail. It also adds the retention
  side of Free's plan limits: an opt-in meeting-api sweep
  (`RETENTION_SWEEP_ENABLED`, off by default) that deletes a genuinely Free-plan recording once
  it is older than the catalog's `recording_retention_days` (7 days today), reading that ceiling
  live off the catalog rather than hardcoding it, and deleting through the same owner-scoped path
  `DELETE /recordings/{id}` uses — storage objects first, then the JSONB row. See
  [Dunning and grace](/how-to/billing#dunning-and-grace-a-payment-fails).
