/** Who-am-I. Returns the VERIFIED identity where the deployment configures admin-api's internal
 *  oracle, and flags `verified: false` where it does not — the client shows a name either way, but
 *  nothing downstream may treat an unverified name as authority. */
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ authenticated: false }, { status: 401, headers: NO_STORE });
  return NextResponse.json({ authenticated: true, user }, { headers: NO_STORE });
}
