/** `GET /api/account` — the signed-in person's profile, recorded sign-in door and dashboard
 *  sessions. The user is the one the identity oracle names for the session cookie; the request has
 *  no way to name another. */
import { NextResponse } from "next/server";
import { loadAccount, resolveAccountCaller } from "@/lib/accountApi";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export async function GET() {
  const caller = await resolveAccountCaller();
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status, headers: NO_STORE });
  const loaded = await loadAccount(caller.userId);
  if (!loaded.ok) {
    console.error(`[dashboard-account] read failed for user ${caller.userId}: ${loaded.error}`);
    return NextResponse.json({ error: "Could not read your account right now." }, { status: loaded.status, headers: NO_STORE });
  }
  return NextResponse.json(loaded.account, { headers: NO_STORE });
}
