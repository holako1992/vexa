/** Shapes and pure formatters for `GET /billing/prices` — the prices on sale, as Stripe states
 *  them (`core/identity/services/admin-api/src/admin_api/app/billing/prices.py`). Every amount
 *  shown on the billing page comes from that answer; nothing here holds a price of its own. */

export type PlanId = "pro" | "team";
export type Interval = "month" | "year";

export interface PlanPrice {
  plan: string;
  interval: string;
  /** Minor units, exactly as Stripe's `unit_amount` (cents for USD; whole yen for JPY). */
  unit_amount: number;
  currency: string;
}

export interface PriceList {
  prices: PlanPrice[];
}

export function findPrice(list: readonly PlanPrice[], plan: PlanId, interval: Interval): PlanPrice | null {
  return list.find((p) => p.plan === plan && p.interval === interval) ?? null;
}

/** "$5", "$4.99", "€20", "¥500" — the currency's own minor-unit count decides the divisor, and
 *  a whole amount drops its ".00". */
export function formatAmount(price: Pick<PlanPrice, "unit_amount" | "currency">, locale?: string): string {
  const currency = price.currency.toUpperCase();
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = price.unit_amount / 10 ** digits;
  const whole = Number.isInteger(value);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** "$5 / month", "$50 / year". */
export function formatPlanPrice(price: PlanPrice, locale?: string): string {
  return `${formatAmount(price, locale)} / ${price.interval}`;
}

/** Whole-percent saving of paying yearly over twelve monthly payments, or `null` when there is
 *  nothing honest to claim: either price missing, different currencies, or no saving at all. */
export function yearlySavingPercent(monthly: PlanPrice | null, yearly: PlanPrice | null): number | null {
  if (!monthly || !yearly) return null;
  if (monthly.currency.toLowerCase() !== yearly.currency.toLowerCase()) return null;
  const twelveMonths = monthly.unit_amount * 12;
  if (twelveMonths <= 0 || yearly.unit_amount >= twelveMonths) return null;
  const percent = Math.round((1 - yearly.unit_amount / twelveMonths) * 100);
  return percent > 0 ? percent : null;
}
