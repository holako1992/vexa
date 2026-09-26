/** DB-77 admin overrides — the panel's ONE write path. PATCH forwards the admin's
 *  `max_concurrent_bots`/`plan_override`/`quota_bonus` straight to admin-api's
 *  `PATCH /admin/users/{id}` (admin tier, X-Admin-API-Key, never sent to the browser), which
 *  validates the plan id (422 unknown) and the bonus (422 negative) and stamps
 *  `quota_bonus_period_start` itself. This route invents no validation of its own — admin-api's
 *  response (200 with the updated user, or its error) passes straight through. Same gate +
 *  404-hiding as every other /api/admin/* route (../../gate.ts). */
import { NextRequest, NextResponse } from "next/server";
import { patchUser } from "../../../auth/adminApi";
import { requireAdmin } from "../../gate";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return new NextResponse(null, { status: 404 });

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const result = await patchUser(id, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error || "Update failed" },
      { status: result.status || 502, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
