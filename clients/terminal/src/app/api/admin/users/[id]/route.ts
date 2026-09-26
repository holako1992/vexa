/** Admin overrides — the panel's ONE write path. PATCH forwards the admin's
 *  `max_concurrent_bots`/`plan_override`/`quota_bonus` straight to admin-api's
 *  `PATCH /admin/users/{id}` (admin tier, X-Admin-API-Key, never sent to the browser), which
 *  validates the plan id (422 unknown) and the bonus (422 negative) and stamps
 *  `quota_bonus_period_start` itself. This route forwards only those three keys and a numeric id; value
 *  validation is admin-api's, and its response (200 or its error) passes straight through. Same gate +
 *  404-hiding as every other /api/admin/* route (../../gate.ts). */
import { NextRequest, NextResponse } from "next/server";
import { patchUser } from "../../../auth/adminApi";
import { requireAdmin } from "../../gate";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return new NextResponse(null, { status: 404 });

  const { id } = await ctx.params;
  if (!/^[0-9]{1,18}$/.test(id)) return new NextResponse(null, { status: 404 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  // Only the panel's three fields are forwarded; any other key never reaches the admin tier.
  const src = raw as Record<string, unknown>;
  const body: Parameters<typeof patchUser>[1] = {};
  if ("max_concurrent_bots" in src) body.max_concurrent_bots = src.max_concurrent_bots as number;
  if ("plan_override" in src) body.plan_override = src.plan_override as string | null;
  if ("quota_bonus" in src) body.quota_bonus = src.quota_bonus as number | null;

  const result = await patchUser(id, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error || "Update failed" },
      { status: result.status || 502, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
