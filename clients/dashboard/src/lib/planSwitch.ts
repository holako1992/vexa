/** What switching from the caller's live subscription to another plan card means, mirroring the
 *  core's rules (`core/identity/services/admin-api/src/admin_api/app/billing/plan_change.py`):
 *  an upgrade on the same interval applies now with nothing charged until renewal; a downgrade,
 *  or any monthly↔yearly switch, waits for the end of the paid period. Pure — no fetches. */
import type { Interval, PlanId } from "./prices";

export interface SubscriptionView {
  plan: string | null;
  interval: string | null;
  pending_change: { plan: string; interval: string | null; at: string } | null;
  /** Set to end at the close of the paid period; `POST /billing/resume` calls it off. */
  cancel_at_period_end?: boolean;
}

export type SwitchKind = "current" | "pending" | "now" | "scheduled";

const RANK: Record<string, number> = { pro: 1, team: 2 };
export const PLAN_NAMES: Record<string, string> = { free: "Free", pro: "Pro", team: "Team" };
export const INTERVAL_ADJECTIVE: Record<string, string> = { month: "monthly", year: "yearly" };

export function switchKind(sub: SubscriptionView, plan: PlanId, interval: Interval): SwitchKind {
  if (sub.plan === plan && sub.interval === interval) return "current";
  const pending = sub.pending_change;
  if (pending && pending.plan === plan && pending.interval === interval) return "pending";
  const upgrade = (RANK[plan] ?? 0) > (RANK[sub.plan ?? ""] ?? 0);
  return upgrade && interval === sub.interval ? "now" : "scheduled";
}

/** "Pro monthly". */
export function planName(plan: string | null, interval: string | null): string {
  const name = PLAN_NAMES[plan ?? ""] ?? plan ?? "";
  const adjective = INTERVAL_ADJECTIVE[interval ?? ""];
  return adjective ? `${name} ${adjective}` : name;
}

/** The card's button label for a subscriber. */
export function switchButtonLabel(sub: SubscriptionView, plan: PlanId, interval: Interval): string {
  const kind = switchKind(sub, plan, interval);
  if (kind === "current") return "Current plan";
  if (kind === "pending") return "Scheduled";
  if (sub.plan === plan) return `Switch to ${INTERVAL_ADJECTIVE[interval]}`;
  return `Switch to ${PLAN_NAMES[plan]}`;
}

/** The confirmation sentence. `renewal` is the formatted end of the paid period ("2 Nov");
 *  `targetPrice` the formatted target price ("$100 / year"), or null when Stripe gave none. */
export function switchExplanation(
  sub: SubscriptionView,
  plan: PlanId,
  interval: Interval,
  renewal: string,
  targetPrice: string | null,
): string {
  const kind = switchKind(sub, plan, interval);
  const target = planName(plan, interval);
  const billed = targetPrice ? `billed ${targetPrice}` : `billed the ${target} price`;
  if (kind === "now") {
    return `${PLAN_NAMES[plan]} starts now. Nothing is charged today; from your renewal on ${renewal} you'll be ${billed}.`;
  }
  const upgrade = (RANK[plan] ?? 0) > (RANK[sub.plan ?? ""] ?? 0);
  if (upgrade) {
    return `${PLAN_NAMES[plan]} starts now at your current ${INTERVAL_ADJECTIVE[sub.interval ?? ""] ?? ""} rate. From your renewal on ${renewal} you'll be on ${target}, ${billed}.`;
  }
  return `You'll keep ${planName(sub.plan, sub.interval)} until ${renewal}, then move to ${target}, ${billed}.`;
}
