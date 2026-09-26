# `app/billing/` — the plan catalog, the entitlement resolver, and the usage meter

The billing domain, built inside identity (DB-70, DB-71, DB-72): everything downstream (spawn-time
quota enforcement, Stripe sync, the dashboard's billing page) reads what this package defines
rather than re-deriving its own numbers.

## DB-72 — where quota enforcement actually happens (and where it deliberately does not)

Two doors read this package, at two different costs, and the split is the point:

- **`/internal/validate`** (`main.py`) — the gateway's authz oracle, called on EVERY proxied
  request. It calls `resolve_plan` (pure, no I/O) to combine the resolved plan's
  `concurrent_bots` with the pre-billing `users.max_concurrent_bots` column
  (`catalog.effective_concurrent_cap` — see its docstring for the combination rule) into the
  `max_concurrent` the gateway forwards as `x-user-limits`. No usage query rides this path —
  concurrency is a live count `meeting-api` already keeps in its own table (`count_active_bots`),
  never re-derived here.
- **`/internal/users/{id}/bot-context`** (`main.py`) — called ONCE per spawn attempt, by
  `meeting_api.bot_spawn.service.request_bot`, for BOTH a manual `POST /bots` and an auto-join
  dispatch (the same best-effort fetch that already resolves transcription/capture/bot-name — no
  second call). THIS is where the MONTHLY meeting quota is metered: `resolve_entitlements` with a
  real `MeetingsUsagePort(db)` runs here, and the response carries a `quota` block
  (`meetings_per_month`, `meetings_used`, `resets_at`, `upgrade_url`) only when the resolved plan
  has a finite `meetings_per_month` — an unlimited plan omits the key, and meeting-api then does
  no check at all. The SAME response also states `max_minutes_per_meeting` whenever the resolved
  plan names one AT ALL (Free 60, Pro/Team 240) — a separate axis from `quota`, so it is NOT gated
  on `meetings_per_month`: Pro/Team have no monthly meeting quota but still have a per-meeting
  minute cap, and gating this field the same way `quota` is would silently drop it for both.

meeting-api enforces all three numbers (concurrency, monthly quota, per-meeting minutes); this
package only resolves and reports them — see
`core/meetings/services/meeting-api/src/meeting_api/bot_spawn/README.md` for the enforcement side
(the exact refusal body, the 402 status, the auto-join skip, and the per-meeting minute cap's
combination with the caller's own `automatic_leave.max_bot_time`).

**The concurrent-bot cap is a product change for existing Free users**, stated once here: every
Free user whose `max_concurrent_bots` column still reads the untouched legacy default (3) moves to
the Free plan's `concurrent_bots` (1) the moment this ships — see
`catalog.effective_concurrent_cap`'s docstring.

- `catalog.py` — `PLANS`: the free/pro/team limits, as data. This is the **single place a
  price or a limit changes** — a one-file edit, never a number re-typed at each call site. It
  also defines the `UNLIMITED` sentinel (`None`, never a large integer) that every consumer of
  a `PlanLimits` field must check for before doing arithmetic on it. `effective_concurrent_cap`
  (DB-72) is the ONE place the resolved plan's `concurrent_bots` and the pre-billing
  `users.max_concurrent_bots` column combine into the number both `/internal/validate` and
  `/internal/users/{id}/bot-context` return.
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
