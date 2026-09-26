- **The plan's per-meeting minute cap is now actually enforced (#1672).** `automatic_leave
  .max_bot_time` on `POST /bots` used to be accepted (never a 422) and silently dropped — the bot
  only ever honoured the deployment-wide `BOT_MAX_ACTIVE_MS` env default (4h). meeting-api now
  reads the caller's plan's `max_minutes_per_meeting` (Free 60, Pro/Team 240 — the SAME best-effort
  `bot-context` fetch the monthly meeting quota already uses, no second admin-api call) and
  combines it with any caller-supplied `max_bot_time` by minimum before the invocation ships; the
  bot then floors that against its own `BOT_MAX_ACTIVE_MS`, so the effective cap is the min of all
  three. A bot that hits the cap ends with the existing `completion_reason: max_bot_time_exceeded`
  — no new reason. See [the per-plan minute cap](/troubleshooting/completion-reasons#the-per-plan-minute-cap).
