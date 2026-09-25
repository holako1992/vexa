- **Billing page and paywall in the dashboard (DB-74 read-only half, DB-75, #1644).** `/billing`
  shows the signed-in user's plan, meeting/minute usage, billing-period reset date, and any
  past-due or cancel-at-period-end state, from `GET /user/entitlements` (now on the dashboard's
  read allowlist). No checkout or upgrade buttons yet — DB-73's Stripe endpoint contract on core
  isn't final, so the page leaves a labelled, empty slot for a later task. The Send-Bot dialog now
  shows a "N of M meetings left this month · resets &lt;date&gt;" line under Send for a finite
  plan (informational only — the server, never the client, decides whether a send is admitted),
  and a `POST /bots` refused with DB-72's `402 {"error": "quota_exceeded", ...}` body shows the
  reset date and a link to `upgrade_url`, or `/billing` when the producer sent none.
  **Fix:** `ApiError` now carries the full parsed error body, not just a squashed `detail` string
  — the previous shape silently dropped DB-72's unwrapped 402 fields (`limit`, `used`,
  `resets_at`, `upgrade_url`) because that response has no `{"detail": ...}` envelope.
  **Fix:** the meeting summary panel rendered its own `_none recorded in this meeting._`
  placeholder (and any other inline `**strong**`/`_emphasis_` in the note's prose) as literal
  underscores instead of formatting it; it now parses inline emphasis into plain React elements,
  still with no markdown library and no `dangerouslySetInnerHTML`.
