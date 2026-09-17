/** The dashboard's session seam — the ONE place a request's identity is established, and the one
 *  place the session cookies are written.
 *
 *  Two tiers, deliberately distinct:
 *    • `sessionToken()` — the credential. The httpOnly `vexa-token` cookie, and the only thing
 *      ever sent upstream. The gateway authenticates it and scopes every row to its owner, so
 *      possession of this token IS the authorization decision for meeting data.
 *    • `currentUser()` — the identity, VERIFIED against admin-api's internal oracle when the
 *      deployment configures it. Used to render who is signed in and to refuse a revoked token
 *      at this edge instead of one hop later. Where the oracle is not configured, it degrades to
 *      "a token is present" and says so via `verified: false` — never to trusting the
 *      display-only `vexa-user-info` cookie for anything but a name on screen.
 */
import { cookies } from "next/headers";
import { AUTH_COOKIE, USER_INFO_COOKIE, validateAuthToken, validationConfigured } from "./adminApi";
import { isSecureDeployment } from "./security";

export interface DashboardUser {
  email: string | null;
  name: string | null;
  /** true when admin-api's oracle confirmed the token this request carries. */
  verified: boolean;
}

/** The raw auth token for this request, or undefined when the caller is not signed in. */
export async function sessionToken(): Promise<string | undefined> {
  try {
    return (await cookies()).get(AUTH_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

/** Display-only identity from the `vexa-user-info` cookie. NEVER an authorization input. */
async function displayIdentity(): Promise<{ email: string | null; name: string | null }> {
  try {
    const raw = (await cookies()).get(USER_INFO_COOKIE)?.value;
    if (!raw) return { email: null, name: null };
    const parsed = JSON.parse(raw) as { email?: string; name?: string };
    return { email: parsed.email ?? null, name: parsed.name ?? null };
  } catch {
    return { email: null, name: null };
  }
}

/** Resolve the signed-in user, or null when this request carries no usable session. */
export async function currentUser(): Promise<DashboardUser | null> {
  const token = await sessionToken();
  if (!token) return null;

  if (validationConfigured()) {
    const validated = await validateAuthToken(token);
    // A 401 is a decision: the token is revoked or bogus, so there is no session. A 503 is the
    // oracle being unreachable, which must not log everyone out of a working deployment — the
    // gateway still authenticates every data call, so we fall through to the unverified tier.
    if (validated.ok) {
      const display = await displayIdentity();
      return { email: validated.email, name: display.name ?? validated.email, verified: true };
    }
    if (validated.status === 401) return null;
    console.warn(`[dashboard-auth] identity oracle unavailable (${validated.status}): ${validated.error}`);
  }

  const display = await displayIdentity();
  return { email: display.email, name: display.name ?? display.email, verified: false };
}

/** Write the session cookies. The single writer — both the email login and the OAuth callback
 *  land here, so the cookie flags cannot drift apart between the two paths. */
export async function setSessionCookies(user: { email: string; name?: string | null }, token: string): Promise<void> {
  const opts = {
    httpOnly: true,
    secure: isSecureDeployment(),
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  };
  const store = await cookies();
  store.set(AUTH_COOKIE, token, opts);
  store.set(
    USER_INFO_COOKIE,
    JSON.stringify({ email: user.email, name: user.name || user.email.split("@")[0] }),
    opts,
  );
}

/** Clear the session cookies (sign-out). */
export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  for (const name of [AUTH_COOKIE, USER_INFO_COOKIE]) {
    store.set(name, "", { httpOnly: true, secure: isSecureDeployment(), sameSite: "lax", maxAge: 0, path: "/" });
  }
}
