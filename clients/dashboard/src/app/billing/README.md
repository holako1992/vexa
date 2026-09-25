# `src/app/billing/` — the billing page

`/billing` (DB-74's read-only half, DB-75's paywall companion page): current plan, usage meters
(meetings, minutes), the billing period's reset date, and any past-due / cancel-at-period-end
state, all read from `GET /api/vexa/user/entitlements`. The view itself lives in
`src/components/BillingView.tsx` — this file only resolves the signed-in user and composes it
inside `Shell`, the same split every other route in `src/app/` uses.

No checkout or portal controls here. DB-73's Stripe endpoint contract (`billing/checkout`,
`billing/portal`) is not final, so `BillingView` leaves a labelled, empty slot rather than
building buttons against an API that could still change shape — a later task fills it once those
routes land on `lib/upstream.ts`'s allowlist.
