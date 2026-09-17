/** Direct email sign-in — the no-OAuth path, for local and test deployments.
 *
 *  POST {email} → find-or-create the user at admin-api, mint an APIToken, set the session cookies.
 *  No SMTP, no magic link, and therefore no proof the caller owns the address: this is a DEBUG
 *  door, and it is closed by default. It opens only when DASHBOARD_ALLOW_EMAIL_LOGIN=true, and
 *  even then only for addresses matching DASHBOARD_EMAIL_LOGIN_PATTERN (default: contains "test").
 *  Real sign-in is Google / Microsoft OAuth.
 *
 *  Guards, in order: same-origin write · rate limit · feature flag · format · allowed address.
 */
import { NextResponse, type NextRequest } from "next/server";
import { findOrCreateUserToken } from "@/lib/adminApi";
import { setSessionCookies } from "@/lib/session";
import { isSameOriginWrite } from "@/lib/security";
import { hit, clientKey } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 5 attempts per 10 minutes per caller. Bounds account creation and token minting. */
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;

function emailAllowed(email: string): boolean {
  const pattern = process.env.DASHBOARD_EMAIL_LOGIN_PATTERN;
  if (!pattern) return email.includes("test");
  try {
    return new RegExp(pattern, "i").test(email);
  } catch {
    // A malformed operator regex must not silently widen the door.
    console.error("[dashboard-auth] DASHBOARD_EMAIL_LOGIN_PATTERN is not a valid regex — refusing email login");
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginWrite(request)) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403, headers: NO_STORE });
  }

  const limited = hit(`login:${clientKey(request.headers)}`, LIMIT, WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  if (process.env.DASHBOARD_ALLOW_EMAIL_LOGIN !== "true") {
    return NextResponse.json(
      { error: "Email sign-in is disabled on this deployment — use Google or Microsoft." },
      { status: 403, headers: NO_STORE },
    );
  }

  let email: unknown;
  try {
    ({ email } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }
  if (typeof email !== "string" || !email.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400, headers: NO_STORE });
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_RE.test(normalized)) {
    return NextResponse.json({ error: "Invalid email format" }, { status: 400, headers: NO_STORE });
  }
  if (!emailAllowed(normalized)) {
    return NextResponse.json(
      { error: "This address is not allowed to use email sign-in — use Google or Microsoft." },
      { status: 403, headers: NO_STORE },
    );
  }

  const result = await findOrCreateUserToken(normalized);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status || 500, headers: NO_STORE });
  }

  await setSessionCookies({ email: result.user.email, name: result.user.name }, result.token);
  return NextResponse.json({ success: true }, { headers: NO_STORE });
}
