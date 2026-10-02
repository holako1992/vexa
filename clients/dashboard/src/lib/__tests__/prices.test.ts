import { describe, expect, it } from "vitest";
import { findPrice, formatAmount, formatPlanPrice, yearlySavingPercent, type PlanPrice } from "../prices";

const usd = (plan: string, interval: string, unit_amount: number): PlanPrice => ({ plan, interval, unit_amount, currency: "usd" });

describe("formatAmount", () => {
  it("drops .00 on a whole amount and keeps cents otherwise", () => {
    expect(formatAmount({ unit_amount: 500, currency: "usd" }, "en-US")).toBe("$5");
    expect(formatAmount({ unit_amount: 499, currency: "usd" }, "en-US")).toBe("$4.99");
    expect(formatAmount({ unit_amount: 10000, currency: "usd" }, "en-US")).toBe("$100");
  });

  it("reads a zero-decimal currency's unit_amount as whole units", () => {
    expect(formatAmount({ unit_amount: 500, currency: "jpy" }, "en-US")).toBe("¥500");
  });
});

describe("formatPlanPrice", () => {
  it("names the interval", () => {
    expect(formatPlanPrice(usd("pro", "month", 500), "en-US")).toBe("$5 / month");
    expect(formatPlanPrice(usd("pro", "year", 5000), "en-US")).toBe("$50 / year");
  });
});

describe("findPrice", () => {
  const list = [usd("pro", "month", 500), usd("team", "year", 10000)];
  it("matches plan and interval together", () => {
    expect(findPrice(list, "pro", "month")).toEqual(list[0]);
    expect(findPrice(list, "pro", "year")).toBeNull();
    expect(findPrice(list, "team", "year")).toEqual(list[1]);
  });
});

describe("yearlySavingPercent", () => {
  it("rounds the saving over twelve monthly payments", () => {
    expect(yearlySavingPercent(usd("pro", "month", 500), usd("pro", "year", 5000))).toBe(17);
    expect(yearlySavingPercent(usd("team", "month", 2000), usd("team", "year", 10000))).toBe(58);
  });

  it("claims nothing when a price is missing, currencies differ, or yearly is no cheaper", () => {
    expect(yearlySavingPercent(null, usd("pro", "year", 5000))).toBeNull();
    expect(yearlySavingPercent(usd("pro", "month", 500), null)).toBeNull();
    expect(yearlySavingPercent(usd("pro", "month", 500), { ...usd("pro", "year", 5000), currency: "eur" })).toBeNull();
    expect(yearlySavingPercent(usd("pro", "month", 500), usd("pro", "year", 6000))).toBeNull();
    expect(yearlySavingPercent(usd("pro", "month", 500), usd("pro", "year", 7000))).toBeNull();
  });
});
