/** `lib/entitlements.ts` — weighted toward the fact the backend states as law: unknown usage
 *  (`null`) must never render as `0`, and an unlimited plan (`null` limit) must never render as a
 *  number either. */
import { describe, expect, it } from "vitest";
import {
  formatDayMonth,
  formatMeetingsUsage,
  formatMinutesUsage,
  formatRemainingAllowance,
  formatResetDate,
  isQuotaExceeded,
  planStatusLabel,
  type Entitlements,
} from "../entitlements";

const FREE_LIMITS = {
  meetings_per_month: 1,
  max_minutes_per_meeting: 60,
  concurrent_bots: 1,
  recording_retention_days: 7,
  ai_summaries_per_month: 1,
};

const UNLIMITED_LIMITS = {
  meetings_per_month: null,
  max_minutes_per_meeting: 240,
  concurrent_bots: 2,
  recording_retention_days: null,
  ai_summaries_per_month: null,
};

function entitlements(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    plan_id: "free",
    catalog_version: "2026-09-18",
    status: null,
    will_renew: true,
    grace_until: null,
    period: { start: "2026-09-01T00:00:00+00:00", end: "2026-10-01T00:00:00+00:00" },
    limits: FREE_LIMITS,
    usage: { meetings_used: 0, minutes_used: 0 },
    ...overrides,
  };
}

describe("formatMeetingsUsage", () => {
  it("reports a finite plan as used-of-limit", () => {
    expect(formatMeetingsUsage(FREE_LIMITS, { meetings_used: 1, minutes_used: 30 })).toBe(
      "1 of 1 meetings used",
    );
  });

  it("reports an unlimited plan as Unlimited regardless of usage", () => {
    expect(formatMeetingsUsage(UNLIMITED_LIMITS, { meetings_used: 40, minutes_used: 900 })).toBe(
      "Unlimited",
    );
    expect(formatMeetingsUsage(UNLIMITED_LIMITS, { meetings_used: null, minutes_used: null })).toBe(
      "Unlimited",
    );
  });

  it("reports unknown usage as unavailable, NEVER as 0", () => {
    const out = formatMeetingsUsage(FREE_LIMITS, { meetings_used: null, minutes_used: null });
    expect(out).toBe("Usage unavailable");
    expect(out).not.toContain("0");
  });
});

describe("formatMinutesUsage", () => {
  it("formats a known count, singular and plural", () => {
    expect(formatMinutesUsage({ meetings_used: 0, minutes_used: 1 })).toBe("1 minute used");
    expect(formatMinutesUsage({ meetings_used: 0, minutes_used: 42 })).toBe("42 minutes used");
  });

  it("reports unknown usage as unavailable, never 0", () => {
    expect(formatMinutesUsage({ meetings_used: null, minutes_used: null })).toBe("Usage unavailable");
  });
});

describe("formatDayMonth / formatResetDate", () => {
  it("renders day + full month name in UTC", () => {
    expect(formatDayMonth("2026-10-01T00:00:00+00:00")).toBe("1 October");
    expect(formatResetDate("2026-10-01T00:00:00+00:00")).toBe("Resets 1 October");
  });

  it("returns null for a missing or unparseable date", () => {
    expect(formatDayMonth(null)).toBeNull();
    expect(formatDayMonth(undefined)).toBeNull();
    expect(formatDayMonth("not-a-date")).toBeNull();
    expect(formatResetDate(null)).toBeNull();
  });
});

describe("formatRemainingAllowance", () => {
  it("shows remaining/limit with the reset date for a finite free plan, 'meetings' plural even at a limit of 1", () => {
    const e = entitlements({ usage: { meetings_used: 0, minutes_used: 0 } });
    expect(formatRemainingAllowance(e)).toBe("1 of 1 free meetings left this month · resets 1 October");
  });

  it("floors remaining at zero on an exhausted plan", () => {
    const e = entitlements({ usage: { meetings_used: 1, minutes_used: 60 } });
    expect(formatRemainingAllowance(e)).toBe("0 of 1 free meetings left this month · resets 1 October");
  });

  it("returns null for an unlimited plan — nothing informative to show", () => {
    const e = entitlements({ plan_id: "pro", limits: UNLIMITED_LIMITS });
    expect(formatRemainingAllowance(e)).toBeNull();
  });

  it("returns null when usage is unknown — never renders a fabricated remaining count", () => {
    const e = entitlements({ usage: { meetings_used: null, minutes_used: null } });
    expect(formatRemainingAllowance(e)).toBeNull();
  });
});

describe("planStatusLabel", () => {
  it("is null for a normally-renewing plan", () => {
    expect(planStatusLabel(entitlements())).toBeNull();
  });

  it("flags a past_due plan with its grace date", () => {
    const label = planStatusLabel(
      entitlements({ status: "past_due", will_renew: false, grace_until: "2026-10-08T00:00:00+00:00" }),
    );
    expect(label).toBe("Payment past due — grace period until 8 October");
  });

  it("flags cancel-at-period-end without a grace date", () => {
    const label = planStatusLabel(entitlements({ status: "canceled", will_renew: false }));
    expect(label).toBe("Cancels at the end of the billing period");
  });
});

describe("isQuotaExceeded", () => {
  it("recognizes the unwrapped 402 body", () => {
    expect(
      isQuotaExceeded({ error: "quota_exceeded", limit: 1, used: 1, resets_at: "2026-10-01T00:00:00Z", upgrade_url: null }),
    ).toBe(true);
  });

  it("refuses anything else, including the old {detail} envelope and a null body", () => {
    expect(isQuotaExceeded({ detail: "quota_exceeded" })).toBe(false);
    expect(isQuotaExceeded({ error: "not_found" })).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
    expect(isQuotaExceeded(undefined)).toBe(false);
    expect(isQuotaExceeded("quota_exceeded")).toBe(false);
  });
});
