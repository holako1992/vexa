# users

`route.ts` — `GET /api/admin/users?email=...`: looks a user up by email through admin-api's admin
tier for the panel's Users tab. `[id]/route.ts` — the write path (`PATCH`), forwarding
`max_concurrent_bots`/`plan_override`/`quota_bonus` straight through to `PATCH /admin/users/{id}`.
Both are gated by `../gate.ts` (404 for non-admins) and never leak `X-Admin-API-Key` to the browser.
