# `src/app/billing/` — the billing page

`/billing` (DB-74's plan/usage view, DB-75's paywall companion page, DB-74b's write controls):
current plan, usage meters (meetings, minutes), the billing period's reset date, any past-due /
cancel-at-period-end state (all read from `GET /api/vexa/user/entitlements`), a **Manage
subscription** button (`POST /billing/portal`), and per-plan **Upgrade** buttons with a
monthly/yearly toggle (`POST /billing/checkout {plan, interval}`). The view itself lives in
`src/components/BillingView.tsx` — this file only resolves the signed-in user and composes it
inside `Shell`, the same split every other route in `src/app/` uses.

Both write endpoints answer `{url}` — a Stripe-hosted Checkout or Portal session —
`isTrustedBillingRedirect()` (`lib/security.ts`) checks it before the page ever calls
`window.location.assign()`. A portal call with no Stripe customer on file yet (never checked out)
is a 409; the view shows a toast pointing at the Upgrade buttons on the same page rather than a
generic error.
