- **Stripe checkout, portal, and plan-sync webhook (DB-73, #1643).** `POST /billing/checkout`
  starts a Stripe Checkout Session for `pro`/`team` (monthly or yearly), creating the account's
  Stripe customer on first use; `POST /billing/portal` opens the Stripe Customer Portal for card
  changes, cancellation, and invoices. `POST /billing/webhook` is the only writer of a user's
  subscription fields: on any subscription-affecting event it re-reads the subscription's
  **current** state from the Stripe API rather than trusting the delivered body, so redelivery is
  a no-op and out-of-order delivery converges on Stripe's real state either way. A price id with
  no matching plan in the catalog is logged and ignored, never guessed. A `subscription.changed`
  fact is published to flows alongside `onboarding.completed`. See
  [Subscribe, manage billing, and receive plan changes](/how-to/billing) for the exact Stripe
  dashboard setup and env keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_CHECKOUT_SUCCESS_URL`/`_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL`,
  `STRIPE_PRICE_{PRO,TEAM}_{MONTHLY,YEARLY}`) — every one of checkout/portal/webhook answers a
  typed 503 naming what's missing until they're set, and the rest of admin-api is unaffected.
  **Not yet wired:** the webhook's public ingress. Every route the gateway fronts requires an
  `X-API-Key`, which Stripe cannot present, and admin-api itself binds loopback-only in the
  standard deploy — so `POST /billing/webhook` exists and is fully tested against admin-api
  directly, but reaching it from Stripe's real servers needs a deployment-level ingress decision
  this change does not make. Checkout and the portal are unaffected and route through the gateway
  today.
