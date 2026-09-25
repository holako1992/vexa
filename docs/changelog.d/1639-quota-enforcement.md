- **Quota enforcement at bot admission (DB-72, #1639).** `POST /bots` and calendar auto-join now
  enforce the monthly meeting quota from the billing catalog (Free: 1 meeting/month; Pro/Team:
  unlimited) at the point a bot is admitted, not just on the entitlements page. A meeting a bot
  never reached (a `requested`/`joining`/`awaiting_admission` failure) never counts against the
  quota — only a bot that actually got into the room does. An exhausted quota refuses a manual
  spawn with `402 Payment Required` and `{"error": "quota_exceeded", "limit", "used",
  "resets_at", "upgrade_url"}`; an auto-join dispatch SKIPS instead of joining, recording the
  reason on the meeting so it is visible why the bot never came.
  **Product change:** the per-user concurrent-bot cap is now the resolved plan's number
  (Free: 1, Pro: 2, Team: 5) combined with any admin-set ceiling — every existing Free user who
  has never been individually adjusted moves from the legacy default of 3 concurrent bots down to
  1. See [Deployment](/deployment) for the `BILLING_UPGRADE_URL` config key.
