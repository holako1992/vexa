/** Sign-out — clears the session cookies. POST only, and same-origin only: a GET sign-out can be
 *  triggered by any image tag on any page, which turns logout into a cross-site nuisance. */
import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookies } from "@/lib/session";
import { isSameOriginWrite } from "@/lib/security";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export async function POST(request: NextRequest) {
  if (!isSameOriginWrite(request)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403, headers: NO_STORE });
  }
  await clearSessionCookies();
  return NextResponse.json({ success: true }, { headers: NO_STORE });
}
