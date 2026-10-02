- **One subscription per account, switched in place.** `POST /billing/checkout` now answers 409
  while the customer already has a live Stripe subscription, and `POST /billing/change {plan,
  interval}` changes that one subscription instead: an upgrade on the same interval applies at
  once with nothing charged until renewal; a downgrade or a monthly↔yearly switch is scheduled
  for the end of the paid period, and choosing the current plan calls it off. The billing page's
  plan cards offer "Switch to …" with a confirmation saying when the switch lands and what it
  bills. A `canceled` subscription now resolves to Free at once — Stripe uses that status only for
  a subscription that has ended — and an older subscription ending no longer overwrites the
  account's live one. A Stripe refusal on any `/billing/*` route answers 502 with Stripe's reason
  instead of a bare 500. See [Switch plans](/how-to/billing#switch-plans).
