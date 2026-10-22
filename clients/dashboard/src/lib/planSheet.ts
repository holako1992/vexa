/** Server-only: the landing page's plan sheet and product name, read where the browser never is.
 *
 *  The plan sheet comes from admin-api's internal edge (`GET /internal/billing/plans`, behind the
 *  same `VEXA_INTERNAL_API_SECRET` the identity oracle uses), so a visitor with no session still
 *  sees the catalog's real limits and Stripe's real prices — and never the secret.
 */
import { parsePlanSheet, type PlanSheet } from "./plans";

/** `null` when the deployment hasn't configured the edge, admin-api can't be reached, or it answers
 *  with something that isn't a plan sheet — the pricing section then says it couldn't load. */
export async function fetchPlanSheet(): Promise<PlanSheet | null> {
  const url = (process.env.VEXA_ADMIN_API_URL || "").replace(/\/$/, "");
  const secret = process.env.VEXA_INTERNAL_API_SECRET || "";
  if (!url || !secret) return null;
  try {
    const res = await fetch(`${url}/internal/billing/plans`, {
      headers: { "X-Internal-Secret": secret },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return parsePlanSheet(await res.json());
  } catch {
    return null;
  }
}

/** The name the public page and the sign-in card use: `PRODUCT_NAME`, else "Vexa". */
export function productName(): string {
  const name = (process.env.PRODUCT_NAME || "").trim();
  return name && name.length <= 60 ? name : "Vexa";
}
