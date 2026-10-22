/** The public plan sheet — admin-api's `GET /internal/billing/plans` — and the pure rules that turn
 *  it into what the landing page's pricing section says.
 *
 *  Every limit is the catalog's (`billing/catalog.py`) and every amount is Stripe's: this module
 *  holds no plan figure of its own, so the public page can never promise what the core won't
 *  enforce. `null` on a limit is the catalog's "unlimited".
 */
import { findPrice, formatPlanPrice, yearlySavingPercent, type PlanId, type PlanPrice } from "./prices";

export interface PlanLimits {
  plan_id: string;
  meetings_per_month: number | null;
  max_minutes_per_meeting: number | null;
  concurrent_bots: number;
  recording_retention_days: number | null;
  ai_summaries_per_month: number | null;
}

export interface PlanSheet {
  plans: PlanLimits[];
  prices: PlanPrice[];
}

export const PLAN_LABELS: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };

function isLimit(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
}

function isPlan(v: unknown): v is PlanLimits {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.plan_id === "string" &&
    isLimit(p.meetings_per_month) &&
    isLimit(p.max_minutes_per_meeting) &&
    typeof p.concurrent_bots === "number" &&
    isLimit(p.recording_retention_days) &&
    isLimit(p.ai_summaries_per_month)
  );
}

function isPrice(v: unknown): v is PlanPrice {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.plan === "string" &&
    typeof p.interval === "string" &&
    typeof p.unit_amount === "number" &&
    typeof p.currency === "string"
  );
}

/** The sheet, or `null` when the answer is not that shape — the page then says it couldn't load
 *  the plans rather than showing a guess. Malformed prices are dropped; a malformed plan fails it. */
export function parsePlanSheet(raw: unknown): PlanSheet | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { plans, prices } = raw as Record<string, unknown>;
  if (!Array.isArray(plans) || plans.length === 0 || !plans.every(isPlan)) return null;
  return { plans, prices: Array.isArray(prices) ? prices.filter(isPrice) : [] };
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function retention(days: number | null): string {
  if (days === null) return "Recordings kept for as long as you keep them";
  if (days === 365) return "Recordings kept for 1 year";
  if (days % 365 === 0) return `Recordings kept for ${days / 365} years`;
  return `Recordings kept for ${count(days, "day", "days")}`;
}

/** The plan's limits as the card's bullet lines, in a fixed order. */
export function planFeatures(plan: PlanLimits): string[] {
  return [
    plan.meetings_per_month === null
      ? "Unlimited meetings"
      : `${count(plan.meetings_per_month, "meeting", "meetings")} a month`,
    plan.max_minutes_per_meeting === null
      ? "No length limit per meeting"
      : `Up to ${plan.max_minutes_per_meeting} minutes per meeting`,
    plan.concurrent_bots === 1
      ? "1 bot in a meeting at a time"
      : `${plan.concurrent_bots} bots in meetings at once`,
    plan.ai_summaries_per_month === null
      ? "AI summaries for every meeting"
      : `${count(plan.ai_summaries_per_month, "AI summary", "AI summaries")} a month`,
    retention(plan.recording_retention_days),
  ];
}

export type PriceLine =
  | { kind: "free" }
  | { kind: "priced"; monthly: string | null; yearly: string | null; yearlySaving: number | null }
  | { kind: "unpriced" };

/** What the card states for price: the free plan is free, a paid plan shows Stripe's prices, and a
 *  paid plan with no confirmed price says so instead of inventing an amount. */
export function priceLine(sheet: PlanSheet, planId: string): PriceLine {
  if (planId === "free") return { kind: "free" };
  const monthly = findPrice(sheet.prices, planId as PlanId, "month");
  const yearly = findPrice(sheet.prices, planId as PlanId, "year");
  if (!monthly && !yearly) return { kind: "unpriced" };
  return {
    kind: "priced",
    monthly: monthly ? formatPlanPrice(monthly) : null,
    yearly: yearly ? formatPlanPrice(yearly) : null,
    yearlySaving: yearlySavingPercent(monthly, yearly),
  };
}
