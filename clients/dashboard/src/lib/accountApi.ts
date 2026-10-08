/** The account page's server side: who the caller is, what admin-api records about them, and the
 *  one write the page makes (sign out everywhere).
 *
 *  Every function here takes the user id the identity oracle returned for THIS request's session
 *  token (`resolveAccountCaller`) — there is no parameter anywhere that a request body, query or
 *  path could fill with someone else's id. admin-api's admin key is used here, on the server, and
 *  never leaves it.
 */
import {
  DASHBOARD_LOGIN_TOKEN_NAME,
  adminRequest,
  deleteUser,
  listUserTokens,
  revokeToken,
  validateAuthToken,
  validationConfigured,
  type AdminTokenInfo,
} from "./adminApi";
import { sessionToken } from "./session";
import type { AccountProvider, AccountSession, AccountView, DeleteOutcome } from "./account";

interface AdminUserRecord {
  id: number;
  email: string;
  name?: string | null;
  data?: Record<string, unknown>;
}

const PROVIDERS = ["google", "microsoft", "email"] as const;

/** The recorded sign-in door, or null when the account has no record (created before the record
 *  existed, or through the terminal / API). Anything unrecognised is treated as no record rather
 *  than shown as if it were known. */
export function providerFromData(data: Record<string, unknown> | undefined): AccountProvider | null {
  const record = data?.identity;
  if (typeof record !== "object" || record === null) return null;
  const { provider, email_verified: verified, verified_at: verifiedAt } = record as Record<string, unknown>;
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) return null;
  return {
    provider: provider as AccountProvider["provider"],
    emailVerified: verified === true,
    verifiedAt: typeof verifiedAt === "string" ? verifiedAt : null,
  };
}

/** The dashboard's own sessions: the `dashboard-login` tokens, newest first. Tokens the person
 *  made for themselves, and the terminal's, are not sessions of this app and are never listed. */
export function sessionsFromTokens(tokens: AdminTokenInfo[]): AccountSession[] {
  const when = (t: AdminTokenInfo) => (t.created_at ? Date.parse(t.created_at) : 0) || 0;
  return tokens
    .filter((t) => t.name === DASHBOARD_LOGIN_TOKEN_NAME)
    .sort((a, b) => when(b) - when(a) || Number(b.id) - Number(a.id))
    .map((t) => ({ createdAt: t.created_at ?? null, lastUsedAt: t.last_used_at ?? null }));
}

export type AccountCaller =
  | { ok: true; userId: number; email: string }
  | { ok: false; status: 401 | 503; error: string };

/** The caller's user id, taken from admin-api's oracle for the session cookie and from nowhere
 *  else. Where the oracle is not configured there is no verified id, so the account surface is
 *  unavailable rather than guessing from the display-only cookie. */
export async function resolveAccountCaller(): Promise<AccountCaller> {
  const token = await sessionToken();
  if (!token) return { ok: false, status: 401, error: "Not signed in" };
  if (!validationConfigured()) {
    return { ok: false, status: 503, error: "Account settings are unavailable: this deployment does not verify identities." };
  }
  const validated = await validateAuthToken(token);
  if (validated.ok) {
    const id = Number(validated.userId);
    if (Number.isSafeInteger(id) && id > 0) return { ok: true, userId: id, email: validated.email };
    return { ok: false, status: 503, error: "Identity check returned an unusable user id." };
  }
  if (validated.status === 401) return { ok: false, status: 401, error: "Not signed in" };
  return { ok: false, status: 503, error: validated.error };
}

export type LoadResult = { ok: true; account: AccountView } | { ok: false; status: number; error: string };

export async function loadAccount(userId: number): Promise<LoadResult> {
  const [user, tokens] = await Promise.all([
    adminRequest<AdminUserRecord>(`/admin/users/${userId}`, { method: "GET" }),
    listUserTokens(userId),
  ]);
  if (!user.ok || !user.data) return { ok: false, status: user.status === 404 ? 404 : 502, error: user.error || "Could not read the account" };
  if (!tokens.ok || !tokens.data) return { ok: false, status: 502, error: tokens.error || "Could not read the sessions" };
  return {
    ok: true,
    account: {
      name: user.data.name ?? null,
      email: user.data.email,
      provider: providerFromData(user.data.data),
      sessions: sessionsFromTokens(tokens.data),
    },
  };
}

export type RevokeResult =
  | { ok: true; revoked: number }
  | { ok: false; status: number; error: string; revoked: number; failed: number };

/** Revoke every `dashboard-login` token the user holds, this browser's included. Each revoke is
 *  attempted; any that fails is counted and reported — a partial sign-out is never reported as
 *  complete. A token that is already gone (404) is the state the caller wanted. */
export async function revokeAllLoginSessions(userId: number): Promise<RevokeResult> {
  const listed = await listUserTokens(userId);
  if (!listed.ok || !listed.data) {
    return { ok: false, status: 502, error: listed.error || "Could not read the sessions", revoked: 0, failed: 0 };
  }
  const mine = listed.data.filter((t) => t.name === DASHBOARD_LOGIN_TOKEN_NAME);
  let revoked = 0;
  let failed = 0;
  for (const t of mine) {
    const r = await revokeToken(t.id);
    if (r.ok || r.notFound) revoked += 1;
    else failed += 1;
  }
  if (failed > 0) {
    return { ok: false, status: 502, error: `${failed} of ${mine.length} sessions could not be revoked`, revoked, failed };
  }
  return { ok: true, revoked };
}

/** How many times one request asks admin-api to finish a deletion that came back partial. The
 *  core locks the account and revokes its tokens before the first erasure step, so the browser has
 *  no session to retry with afterwards: the retry has to happen here, inside this one request. */
export const DELETE_ATTEMPTS = 3;
const DELETE_RETRY_DELAY_MS = 400;

type DeleteCall = () => Promise<{ ok: boolean; status: number }>;

/** Run an account deletion and say what happened. 200 and 404 are one outcome: the account is
 *  gone. 409 is final and changes nothing. A 502 `partial` is retried up to `DELETE_ATTEMPTS`
 *  times; if it is still not done the account stays locked and the outcome is `partial`. Anything
 *  else (admin-api unreachable, an unexpected status) is `unavailable`: it says nothing about
 *  whether the account still exists. */
export async function runAccountDeletion(
  call: DeleteCall,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DeleteOutcome> {
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
    const r = await call();
    if (r.ok || r.status === 404) return "deleted";
    if (r.status === 409) return "blocked";
    if (r.status !== 502) return "unavailable";
    if (attempt < DELETE_ATTEMPTS) await sleep(DELETE_RETRY_DELAY_MS);
  }
  return "partial";
}

export function deleteAccount(userId: number): Promise<DeleteOutcome> {
  return runAccountDeletion(() => deleteUser(userId));
}
