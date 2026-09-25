/** Shapes and pure formatters for `GET /user/entitlements` (DB-70/DB-74/DB-75).
 *
 *  Dependency-free like `upstream.ts` and `summary.ts`, so the formatting rules are tested
 *  directly rather than through a rendered page. Two facts the resolver upstream
 *  (`core/identity/services/admin-api/src/admin_api/app/billing/entitlements.py`,
 *  `billing/catalog.py`) states as law and every consumer here must honor:
 *
 *   - `null` on a limit means UNLIMITED, never a large number to compare against.
 *   - `null` on a usage field means UNKNOWN — nobody has metered it yet — and must never render
 *     as `0`. A meter that is broken must never look like a clean quota.
 */

export interface EntitlementsLimits {
  meetings_per_month: number | null;
  max_minutes_per_meeting: number | null;
  concurrent_bots: number;
  recording_retention_days: number | null;
  ai_summaries_per_month: number | null;
}

export interface EntitlementsUsage {
  meetings_used: number | null;
  minutes_used: number | null;
}

export interface EntitlementsPeriod {
  start: string;
  end: string;
}

export interface Entitlements {
  plan_id: string;
  catalog_version: string;
  status: string | null;
  will_renew: boolean;
  grace_until: string | null;
  period: EntitlementsPeriod;
  limits: EntitlementsLimits;
  usage: EntitlementsUsage;
}

/** The unwrapped `402` body `POST /bots` sends when DB-72's monthly meeting quota is exhausted
 *  (`meeting_api/bot_spawn/router.py`) — no `{"detail": ...}` envelope, so a caller must branch on
 *  `error`, not on the status code or on `ApiError.detail` alone. */
export interface QuotaExceededBody {
  error: "quota_exceeded";
  limit: number | null;
  used: number | null;
  resets_at: string | null;
  upgrade_url: string | null;
}

export function isQuotaExceeded(body: unknown): body is QuotaExceededBody {
  return (
    !!body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).error === "quota_exceeded"
  );
}

/** "1 October" — day-of-month + full month name, read in UTC (the resolver's period boundaries
 *  are UTC calendar-month bounds, `entitlements.py`'s `_calendar_month_bounds`). `null` for a
 *  missing or unparseable date so a caller falls back rather than render "1 Invalid Date". */
export function formatDayMonth(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${day} ${month}`;
}

/** "Resets 1 October" — the billing page's reset-date line. */
export function formatResetDate(iso: string | null | undefined): string | null {
  const dm = formatDayMonth(iso);
  return dm ? `Resets ${dm}` : null;
}

/** "1 of 1 meetings used" / "Unlimited" / "Usage unavailable" — never renders unknown usage as 0. */
export function formatMeetingsUsage(limits: EntitlementsLimits, usage: EntitlementsUsage): string {
  if (limits.meetings_per_month == null) return "Unlimited";
  if (usage.meetings_used == null) return "Usage unavailable";
  return `${usage.meetings_used} of ${limits.meetings_per_month} meetings used`;
}

/** "42 minutes used" / "Usage unavailable" — minutes have no plan ceiling to report against here
 *  (the per-meeting cap lives in `limits.max_minutes_per_meeting`, a different axis), so this is
 *  just the period's count, or unknown. */
export function formatMinutesUsage(usage: EntitlementsUsage): string {
  if (usage.minutes_used == null) return "Usage unavailable";
  return `${usage.minutes_used} minute${usage.minutes_used === 1 ? "" : "s"} used`;
}

/** The Send-Bot dialog's one-line remaining allowance, e.g. "0 of 1 free meetings left this
 *  month · resets 1 October" — or `null` when there is nothing informative to show (an unlimited
 *  plan, or usage the meter hasn't reported yet). This is informational only: the caller must
 *  never use it to disable sending — the server is the authority on whether a send is admitted,
 *  because a stale client read must never refuse a legitimate one. */
export function formatRemainingAllowance(
  e: Pick<Entitlements, "plan_id" | "limits" | "usage" | "period">,
): string | null {
  const limit = e.limits.meetings_per_month;
  if (limit == null) return null;
  const used = e.usage.meetings_used;
  if (used == null) return null;
  const remaining = Math.max(0, limit - used);
  const dm = formatDayMonth(e.period.end);
  const planWord = e.plan_id === "free" ? "free " : "";
  // "meetings" plural always, matching the product's own example copy ("0 of 1 free meetings
  // left this month") even at a limit of 1 — read as "meetings [allowance]", not a per-item count.
  return `${remaining} of ${limit} ${planWord}meetings left this month${dm ? ` · resets ${dm}` : ""}`;
}

/** A one-line status note for past-due / cancel-at-period-end plans, or `null` when the plan is
 *  renewing normally and there is nothing to flag. */
export function planStatusLabel(
  e: Pick<Entitlements, "status" | "will_renew" | "grace_until">,
): string | null {
  if (e.status === "past_due") {
    const dm = formatDayMonth(e.grace_until);
    return dm ? `Payment past due — grace period until ${dm}` : "Payment past due";
  }
  if (e.status != null && !e.will_renew) return "Cancels at the end of the billing period";
  return null;
}
