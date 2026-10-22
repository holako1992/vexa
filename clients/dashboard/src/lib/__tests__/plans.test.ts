import { describe, expect, it } from "vitest";
import { parsePlanSheet, planFeatures, priceLine, type PlanLimits, type PlanSheet } from "../plans";

const FREE: PlanLimits = {
  plan_id: "free",
  meetings_per_month: 1,
  max_minutes_per_meeting: 60,
  concurrent_bots: 1,
  recording_retention_days: 7,
  ai_summaries_per_month: 1,
};
const PRO: PlanLimits = {
  plan_id: "pro",
  meetings_per_month: null,
  max_minutes_per_meeting: 240,
  concurrent_bots: 2,
  recording_retention_days: 365,
  ai_summaries_per_month: null,
};
const TEAM: PlanLimits = { ...PRO, plan_id: "team", concurrent_bots: 5, recording_retention_days: null };

const SHEET: PlanSheet = {
  plans: [FREE, PRO, TEAM],
  prices: [
    { plan: "pro", interval: "month", unit_amount: 1200, currency: "usd" },
    { plan: "pro", interval: "year", unit_amount: 12000, currency: "usd" },
  ],
};

describe("parsePlanSheet", () => {
  it("accepts the core's answer as it is", () => {
    expect(parsePlanSheet({ catalog_version: "x", ...SHEET })).toEqual(SHEET);
  });

  it("refuses an answer with no plans or a malformed plan, so the page never shows a guess", () => {
    expect(parsePlanSheet(null)).toBeNull();
    expect(parsePlanSheet({ plans: [], prices: [] })).toBeNull();
    expect(parsePlanSheet({ plans: [{ ...FREE, concurrent_bots: "1" }], prices: [] })).toBeNull();
    expect(parsePlanSheet({ plans: [{ ...FREE, meetings_per_month: -1 }], prices: [] })).toBeNull();
  });

  it("drops a malformed price and treats missing prices as none", () => {
    expect(parsePlanSheet({ plans: [FREE], prices: [{ plan: "pro" }] })).toEqual({ plans: [FREE], prices: [] });
    expect(parsePlanSheet({ plans: [FREE] })).toEqual({ plans: [FREE], prices: [] });
  });
});

describe("planFeatures", () => {
  it("states every limit the catalog sets, with the catalog's numbers", () => {
    expect(planFeatures(FREE)).toEqual([
      "1 meeting a month",
      "Up to 60 minutes per meeting",
      "1 bot in a meeting at a time",
      "1 AI summary a month",
      "Recordings kept for 7 days",
    ]);
  });

  it("says unlimited where the catalog has no ceiling", () => {
    expect(planFeatures(TEAM)).toEqual([
      "Unlimited meetings",
      "Up to 240 minutes per meeting",
      "5 bots in meetings at once",
      "AI summaries for every meeting",
      "Recordings kept for as long as you keep them",
    ]);
    expect(planFeatures(PRO)[4]).toBe("Recordings kept for 1 year");
  });
});

describe("priceLine", () => {
  it("is free for the free plan whatever Stripe says", () => {
    expect(priceLine(SHEET, "free")).toEqual({ kind: "free" });
  });

  it("shows Stripe's prices and an honest yearly saving", () => {
    expect(priceLine(SHEET, "pro")).toEqual({
      kind: "priced",
      monthly: "$12 / month",
      yearly: "$120 / year",
      yearlySaving: 17,
    });
  });

  it("never invents an amount for a paid plan Stripe has no price for", () => {
    expect(priceLine(SHEET, "team")).toEqual({ kind: "unpriced" });
    expect(priceLine({ plans: SHEET.plans, prices: [] }, "pro")).toEqual({ kind: "unpriced" });
  });
});
