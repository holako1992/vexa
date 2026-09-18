- **New: a plan catalog and a resolved-entitlements endpoint (#1634).** `GET /user/entitlements`
  (`bot`/`tx` scopes, same self-serve tier as `/user/webhook`) resolves a caller's own billing state
  — free/pro/team, concurrent-bot and per-meeting-minute limits, AI-summary allowance, recording
  retention, the current billing period, and a `past_due` grace window — from the Stripe fields
  already modelled on the account. Usage inside that period reports as unknown until the meter lands
  (#DB-71), never as a false zero. This is the seam the dashboard's future billing page and
  spawn-time quota enforcement (#DB-72) both read; no enforcement changes yet.
