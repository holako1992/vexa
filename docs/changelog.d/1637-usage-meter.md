- **`GET /user/entitlements` now reports real usage, not always "unknown" (#1637).** Meetings and
  minutes used in the current billing period are counted live from the existing `meetings` table —
  no second usage table, no counter to keep in sync. A bot that never reached the meeting
  (`requested`/`joining`/`awaiting_admission`, or a `failed` row that never got admitted) does not
  consume the user's quota; a still-running meeting counts its minutes up to now rather than
  waiting for it to end. If the usage query itself fails, the field still reads `unknown` (`null`),
  never `0` — a broken meter must never look like a clean quota to a billing page. See
  [`core/identity/services/admin-api/src/admin_api/app/billing/README.md`](/governance/architecture)
  for which meeting statuses count and why.
