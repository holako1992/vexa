- **Admin plan overrides and quota bonus (DB-77, #1676).** `PATCH /admin/users/{id}` now takes
  `plan_override` (a catalog plan id — `free`/`pro`/`team` — or `null` to clear) and `quota_bonus`
  (a non-negative integer, extra meetings for the CURRENT resolved billing period only; `null`
  clears it) so support can comp a user without touching Stripe. Both flow through the same
  `resolve_plan` every consumer already reads — `GET /user/entitlements`, `POST
  /internal/validate`'s `x-user-limits`, and `/internal/users/{id}/bot-context` (the spawn-time
  quota check `POST /bots` and calendar auto-join go through) — so one PATCH is visible
  everywhere at once. An unknown plan id or a negative bonus is a **422**. A quota bonus is
  stamped with the period it was granted for and does not carry over once that period ends — see
  [Support comps](/how-to/billing#support-comps-admin-overrides). The terminal's hidden admin
  panel (Infra → Users tab) adds a small form for both fields alongside the existing
  `max_concurrent_bots` control.
