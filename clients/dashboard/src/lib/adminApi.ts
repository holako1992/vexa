/** Server-only admin-api client for the dashboard's own auth.
 *
 *  The dashboard holds the SAME auth contract as the terminal — the httpOnly `vexa-token` +
 *  `vexa-user-info` cookies — so a deployment fronting both behind one domain shares one sign-in.
 *  It mirrors the terminal's slice rather than importing it: the two clients are separate npm
 *  projects with no workspace dependency between them (see each Dockerfile), and a client must
 *  not grow a runtime dependency on another client.
 *
 *  Its slice is narrower than the terminal's, because the dashboard's job is narrower: find or
 *  create a user by email, mint an APIToken, bound the number of login tokens, and validate a
 *  token against admin-api's internal oracle. No admin panel, no workspace provisioning.
 *
 *  Every call carries X-Admin-API-Key and is never cached — a cached 404 would make
 *  find-or-create fabricate duplicate users.
 */

export const AUTH_COOKIE = process.env.VEXA_AUTH_COOKIE_NAME || "vexa-token";
export const USER_INFO_COOKIE = process.env.VEXA_USER_INFO_COOKIE_NAME || "vexa-user-info";

export interface AdminUser {
  id: string | number;
  email: string;
  name?: string | null;
}

export interface AdminResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  notFound?: boolean;
  error?: string;
}

function adminConfig(): { url: string; key: string } | null {
  const url = (process.env.VEXA_ADMIN_API_URL || "").replace(/\/$/, "");
  const key = process.env.VEXA_ADMIN_API_KEY || "";
  if (!url || !key || key === "your_admin_api_key_here") return null;
  return { url, key };
}

async function adminRequest<T>(path: string, init: RequestInit = {}, timeout = 15000): Promise<AdminResult<T>> {
  const cfg = adminConfig();
  if (!cfg) return { ok: false, status: 503, error: "Admin API is not configured (VEXA_ADMIN_API_URL / VEXA_ADMIN_API_KEY)" };

  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Admin-API-Key": cfg.key, ...init.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });

    if (res.status === 404) return { ok: false, status: 404, notFound: true };
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      return { ok: false, status: res.status, error: detail || `admin-api returned ${res.status}` };
    }
    if (res.status === 204) return { ok: true, status: 204 };
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch (err) {
    const e = err as Error;
    return { ok: false, status: 0, error: e.name === "TimeoutError" ? "admin-api request timed out" : e.message };
  }
}

function findUserByEmail(email: string): Promise<AdminResult<AdminUser>> {
  return adminRequest<AdminUser>(`/admin/users/email/${encodeURIComponent(email)}`, { method: "GET" });
}

function createUser(email: string): Promise<AdminResult<AdminUser>> {
  return adminRequest<AdminUser>(`/admin/users`, { method: "POST", body: JSON.stringify({ email }) });
}

/** A token as admin-api lists it — metadata only, never the secret value. */
interface AdminTokenInfo {
  id: number;
  name?: string | null;
  created_at?: string | null;
}

/** The mint response — the ONLY place the token value ever crosses. */
interface AdminMintedToken extends AdminTokenInfo {
  token: string;
}

function listUserTokens(userId: string | number): Promise<AdminResult<AdminTokenInfo[]>> {
  return adminRequest<AdminTokenInfo[]>(`/admin/users/${encodeURIComponent(String(userId))}/tokens`, { method: "GET" });
}

function mintUserToken(userId: string | number, opts: { scopes: string[]; name: string }): Promise<AdminResult<AdminMintedToken>> {
  const q = new URLSearchParams({ scopes: opts.scopes.join(","), name: opts.name });
  return adminRequest<AdminMintedToken>(
    `/admin/users/${encodeURIComponent(String(userId))}/tokens?${q.toString()}`,
    { method: "POST" },
  );
}

function revokeToken(tokenId: string | number): Promise<AdminResult<void>> {
  return adminRequest<void>(`/admin/tokens/${encodeURIComponent(String(tokenId))}`, { method: "DELETE" });
}

// ── verified identity — admin-api's internal oracle (`POST /internal/validate`, the same
//    X-Internal-Secret edge the gateway uses). The `vexa-token` auth cookie is the ONLY input; the
//    returned {user_id, email} is the ONLY identity this server trusts. The `vexa-user-info` cookie
//    is display-only: httpOnly stops JS reads, not a hand-crafted Cookie header, so nothing
//    security-relevant may ever be derived from it.

export type ValidatedUser =
  | { ok: true; userId: string | number; email: string }
  | { ok: false; status: number; error: string };

export function validationConfigured(): boolean {
  return !!(process.env.VEXA_ADMIN_API_URL && process.env.VEXA_INTERNAL_API_SECRET);
}

export async function validateAuthToken(token: string): Promise<ValidatedUser> {
  const url = (process.env.VEXA_ADMIN_API_URL || "").replace(/\/$/, "");
  const secret = process.env.VEXA_INTERNAL_API_SECRET || "";
  if (!url || !secret) {
    // Fail closed — an unconfigured oracle must never fall back to trusting client-sendable data.
    return { ok: false, status: 503, error: "Auth validation is not configured (VEXA_ADMIN_API_URL / VEXA_INTERNAL_API_SECRET)" };
  }

  try {
    const res = await fetch(`${url}/internal/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
      body: JSON.stringify({ token }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, status: 401, error: "Not authenticated" };
    if (!res.ok) return { ok: false, status: 503, error: `Token validation failed (admin-api returned ${res.status})` };
    const data = (await res.json()) as { user_id?: string | number; email?: string };
    if (data.user_id === undefined || data.user_id === null || !data.email) {
      return { ok: false, status: 502, error: "Token validation returned no identity" };
    }
    return { ok: true, userId: data.user_id, email: data.email };
  } catch (err) {
    const e = err as Error;
    return { ok: false, status: 503, error: e.name === "TimeoutError" ? "Token validation timed out" : "Token validation unavailable" };
  }
}

/** The stable marker on dashboard login-minted tokens. It is the ONLY set the cap below prunes —
 *  a user's self-serve tokens and their `terminal-login` tokens are never touched. */
export const DASHBOARD_LOGIN_TOKEN_NAME = "dashboard-login";

/** How many `dashboard-login` tokens one user may keep. A cap, not a purge: a few real devices
 *  survive while a sign-in loop cannot mint without bound. */
export function loginTokenCap(): number {
  const raw = parseInt(process.env.VEXA_DASHBOARD_LOGIN_TOKEN_CAP || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/** BEST-EFFORT: after a login mint, bound the user's `dashboard-login` tokens to the newest N.
 *  Every failure is logged and swallowed — a prune problem must never turn a successful sign-in
 *  into a failure. */
async function pruneLoginTokens(userId: string | number): Promise<void> {
  try {
    const listed = await listUserTokens(userId);
    if (!listed.ok || !listed.data) {
      console.warn(`[dashboard-auth] login-token prune skipped (list failed): ${listed.error}`);
      return;
    }
    const cap = loginTokenCap();
    const mine = listed.data
      .filter((t) => t.name === DASHBOARD_LOGIN_TOKEN_NAME)
      .sort((a, b) => {
        const ta = a.created_at ? Date.parse(a.created_at) : NaN;
        const tb = b.created_at ? Date.parse(b.created_at) : NaN;
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        return Number(a.id) - Number(b.id);
      });

    const overflow = mine.slice(0, Math.max(0, mine.length - cap));
    for (const tok of overflow) {
      const revoked = await revokeToken(tok.id);
      if (!revoked.ok) console.warn(`[dashboard-auth] login-token prune: revoke of token ${tok.id} failed (swallowed): ${revoked.error}`);
    }
    if (overflow.length) {
      console.info(`[dashboard-auth] login-token prune: user ${userId} over cap ${cap}, revoked ${overflow.length} oldest login token(s)`);
    }
  } catch (err) {
    console.warn("[dashboard-auth] login-token prune failed (sign-in continues):", (err as Error).message);
  }
}

/** Find the user by email, creating them if absent, then mint the login APIToken.
 *
 *  Scopes are `bot,tx` — join meetings and read transcripts. The dashboard reads meetings and
 *  transcripts and nothing else, so it does not mint the `browser` scope the terminal needs
 *  (least privilege: a leaked dashboard token cannot drive a browser session).
 */
export async function findOrCreateUserToken(
  email: string,
): Promise<{ ok: true; user: AdminUser; token: string } | { ok: false; status: number; error: string }> {
  const found = await findUserByEmail(email);

  let user: AdminUser;
  if (found.ok && found.data) {
    user = found.data;
  } else if (found.notFound) {
    const created = await createUser(email);
    if (!created.ok || !created.data) {
      return { ok: false, status: created.status || 500, error: created.error || "Failed to create user" };
    }
    user = created.data;
  } else {
    return { ok: false, status: found.status || 503, error: found.error || "Failed to look up user" };
  }

  const minted = await mintUserToken(user.id, { scopes: ["bot", "tx"], name: DASHBOARD_LOGIN_TOKEN_NAME });
  if (!minted.ok || !minted.data?.token) {
    return { ok: false, status: minted.status || 500, error: minted.error || "Failed to mint API token" };
  }
  await pruneLoginTokens(user.id);
  return { ok: true, user, token: minted.data.token };
}
