# `app/billing/` — the plan catalog and the entitlement resolver

The billing domain, built inside identity (DB-70): everything downstream (usage metering,
spawn-time quota enforcement, Stripe sync, the dashboard's billing page) reads what this
package defines rather than re-deriving its own numbers.

- `catalog.py` — `PLANS`: the free/pro/team limits, as data. This is the **single place a
  price or a limit changes** — a one-file edit, never a number re-typed at each call site. It
  also defines the `UNLIMITED` sentinel (`None`, never a large integer) that every consumer of
  a `PlanLimits` field must check for before doing arithmetic on it.
- `entitlements.py` — `resolve_plan` (pure: `data` + `now` in, a `ResolvedPlan` out, no clock
  read and no I/O) and `resolve_entitlements` (the async layer that adds usage on top). This is
  where a user's stored Stripe fields (`active`/`trialing`/`past_due`/`canceled`,
  `cancel_at_period_end`, an unrecognized tier string) turn into one resolved plan and period.
- `ports.py` — `UsagePort`, the seam DB-71's real meter fills in, and `NullUsagePort`, which
  reports usage as **unknown**, not zero. Those are different answers: zero means "counted, and
  the count was zero," unknown means "nobody has wired a meter yet." A client that renders
  unknown as `0 of 1 used` would be reporting a fact nobody actually checked — that conflation
  is the specific mistake this file exists to prevent.
