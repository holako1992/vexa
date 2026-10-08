/** `DELETE /api/account/sessions` — sign out everywhere: revoke every `dashboard-login` token the
 *  caller holds at admin-api, then clear this browser's session cookies.
 *
 *  Guards, in order: same-origin write · session (identity oracle) · rate limit. The body is
 *  ignored: whose sessions to revoke is decided by the oracle's answer for the cookie, never by
 *  anything the request says. Cookies are cleared only when every revoke succeeded; a partial
 *  failure answers 502 and leaves the session in place so the person can try again. */
import { NextResponse, type NextRequest } from "next/server";
import { resolveAccountCaller, revokeAllLoginSessions } from "@/lib/accountApi";
import { clearSessionCookies } from "@/lib/session";
import { isSameOriginWrite } from "@/lib/security";
import { hit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

/** 5 per 10 minutes per account: enough for a mistake and a retry, not a loop. */
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;

export async function DELETE(request: NextRequest) {
  if (!isSameOriginWrite(request)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403, headers: NO_STORE });
  }
  const caller = await resolveAccountCaller();
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status, headers: NO_STORE });

  const limited = hit(`account-signout:${caller.userId}`, LIMIT, WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  const result = await revokeAllLoginSessions(caller.userId);
  if (!result.ok) {
    console.error(`[dashboard-account] sign out everywhere failed for user ${caller.userId}: ${result.error}`);
    return NextResponse.json(
      { error: "Some sessions could not be signed out. Nothing was changed on this device — try again." },
      { status: 502, headers: NO_STORE },
    );
  }
  await clearSessionCookies();
  return NextResponse.json({ success: true, revoked: result.revoked }, { headers: NO_STORE });
}
