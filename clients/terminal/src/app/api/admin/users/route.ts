/** DB-77 admin overrides — user lookup for the panel's "Users" tab. GET ?email=... resolves a
 *  user by email through admin-api's admin tier (X-Admin-API-Key, never sent to the browser).
 *  Same gate + 404-hiding as every other /api/admin/* route (../gate.ts): a verified admin gets
 *  the user record (including `data.plan_override`/`data.quota_bonus`), everyone else gets 404.
 *  Read-only — the write path is /api/admin/users/[id] (PATCH). */
import { NextRequest, NextResponse } from "next/server";
import { findUserByEmail } from "../../auth/adminApi";
import { requireAdmin } from "../gate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new NextResponse(null, { status: 404 });

  const email = req.nextUrl.searchParams.get("email")?.trim();
  if (!email) {
    return NextResponse.json({ error: "email query param is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const found = await findUserByEmail(email);
  if (found.notFound) {
    return NextResponse.json({ error: "No user with that email" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!found.ok || !found.data) {
    return NextResponse.json({ error: found.error || "Lookup failed" }, { status: found.status || 502, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(found.data, { headers: { "Cache-Control": "no-store" } });
}
