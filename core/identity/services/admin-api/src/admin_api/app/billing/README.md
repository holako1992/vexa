# `app/billing/` — the plan catalog, the entitlement resolver, and the usage meter

The billing domain, built inside identity (DB-70, DB-71): everything downstream (spawn-time
quota enforcement, Stripe sync, the dashboard's billing page) reads what this package defines
rather than re-deriving its own numbers.

- `catalog.py` — `PLANS`: the free/pro/team limits, as data. This is the **single place a
  price or a limit changes** — a one-file edit, never a number re-typed at each call site. It
  also defines the `UNLIMITED` sentinel (`None`, never a large integer) that every consumer of
  a `PlanLimits` field must check for before doing arithmetic on it.
- `entitlements.py` — `resolve_plan` (pure: `data` + `now` in, a `ResolvedPlan` out, no clock
  read and no I/O) and `resolve_entitlements` (the async layer that adds usage on top). This is
  where a user's stored Stripe fields (`active`/`trialing`/`past_due`/`canceled`,
  `cancel_at_period_end`, an unrecognized tier string) turn into one resolved plan and period.
- `ports.py` — `UsagePort`, the seam a usage meter fills in, and `NullUsagePort`, which reports
  usage as **unknown**, not zero — the fallback `resolve_entitlements` uses when no port is
  supplied. Those are different answers: zero means "counted, and the count was zero," unknown
  means "nobody has wired a meter yet" or "the meter broke." A client that renders unknown as
  `0 of 1 used` would be reporting a fact nobody actually checked — that conflation is the
  specific mistake this file exists to prevent.
- `meetings_usage.py` — **the real `UsagePort` (DB-71)**. `meetings_usage_for_period(db,
  user_id, period_start=, period_end=)` counts straight from the existing `meetings` table
  (`schema/models.py`'s `Meeting`, the same rows `core/meetings/services/meeting-api` writes) —
  no second usage table, no counter to keep in sync. It counts a row only when the bot reached
  the meeting (`active`/`stopping`/`completed`, or `failed` with `data.failure_stage ==
  "active"`); a bot that never got past `requested`/`joining`/`awaiting_admission` never
  consumes the user's quota. Minutes come from `start_time`/`end_time`, counting a still-running
  meeting (`null` `end_time`) up to now rather than as 0. A query failure is caught and reported
  as unknown, never 0 — see the module docstring for the full reasoning and the meeting-api
  source lines it's built from. `MeetingsUsagePort` is the thin per-request `UsagePort` wrapper
  `GET /user/entitlements` passes to `resolve_entitlements`; DB-72 (spawn-time enforcement)
  reuses `meetings_usage_for_period` itself, unmodified.
