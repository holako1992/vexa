/** The plain-words notice for a refused or doomed send: what it says for each producer reason, and
 *  — the part that matters — when it must NOT claim the allowance is spent. */
import { describe, expect, it } from "vitest";
import { isAllowanceSpent, quotaNoticeFrom } from "../quotaNotice";
import type { QuotaExceededBody } from "../entitlements";

const body = (over: Partial<QuotaExceededBody> = {}): QuotaExceededBody => ({
  error: "quota_exceeded", limit: 1, used: 1, resets_at: "2026-10-01T00:00:00Z", upgrade_url: null, ...over,
});

describe("quotaNoticeFrom", () => {
  it("states the limit and the reset date, and points at billing when the producer sent no link", () => {
    const n = quotaNoticeFrom(body());
    expect(n.msg).toBe("You've used your 1 meeting for this billing period. Resets 1 October.");
    expect(n.link).toEqual({ href: "/billing", label: "See billing" });
  });

  it("uses the producer's own upgrade link when it sent one", () => {
    expect(quotaNoticeFrom(body({ upgrade_url: "https://example.test/up" })).link).toEqual({
      href: "https://example.test/up", label: "Upgrade",
    });
  });

  it("pluralises, and copes with no limit or no reset date", () => {
    expect(quotaNoticeFrom(body({ limit: 5 })).msg).toContain("your 5 meetings");
    expect(quotaNoticeFrom(body({ limit: null, resets_at: null })).msg).toBe(
      "You've used your meeting allowance for this billing period.",
    );
  });

  it("an unverified address is explained, not called a spent allowance, and has no plan link", () => {
    const n = quotaNoticeFrom(body({ reason: "identity_unverified" }));
    expect(n.msg).toMatch(/isn't verified/);
    expect(n.msg).not.toMatch(/used your/);
    expect(n.link).toBeUndefined();
  });

  it("a reason it has no words for is not rendered as raw text", () => {
    const n = quotaNoticeFrom(body({ reason: "<script>alert(1)</script>" }));
    expect(n.msg).not.toContain("script");
    expect(n.msg).toMatch(/used your/);
  });
});

describe("isAllowanceSpent", () => {
  const e = (limit: number | null, used: number | null, reason?: string | null) => ({
    limits: { meetings_per_month: limit, max_minutes_per_meeting: 60, concurrent_bots: 1, recording_retention_days: 7, ai_summaries_per_month: 1 },
    usage: { meetings_used: used, minutes_used: 0 },
    reason,
  });

  it("is spent when the metered limit is used up, or a known reason says so", () => {
    expect(isAllowanceSpent(e(1, 1))).toBe(true);
    expect(isAllowanceSpent(e(1, 2))).toBe(true);
    expect(isAllowanceSpent(e(1, 0, "identity_unverified"))).toBe(true);
  });

  it("is not spent with room left, on an unlimited plan, or when usage is unknown", () => {
    expect(isAllowanceSpent(e(1, 0))).toBe(false);
    expect(isAllowanceSpent(e(null, 99))).toBe(false);
    expect(isAllowanceSpent(e(1, null))).toBe(false);
  });

  it("does not treat a reason it has no words for as spent", () => {
    expect(isAllowanceSpent(e(1, 0, "something_new"))).toBe(false);
  });
});
