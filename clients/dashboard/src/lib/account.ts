/** The account page's shapes and wording — client-safe (no server imports), so the API routes and
 *  the view agree on one definition and the view can be tested without a server. */

export interface AccountSession {
  createdAt: string | null;
  lastUsedAt: string | null;
}

/** The sign-in door admin-api recorded for the account (`users.data.identity`). It records ONE
 *  door — the one that last set or upgraded it — not a list of every provider ever used. */
export interface AccountProvider {
  provider: "google" | "microsoft" | "email";
  emailVerified: boolean;
  verifiedAt: string | null;
}

export interface AccountView {
  name: string | null;
  email: string;
  provider: AccountProvider | null;
  sessions: AccountSession[];
}

/** Up to two initials from a name, falling back to the address. */
export function initialsOf(name: string | null, email: string): string {
  const source = (name && name.trim()) || email || "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const PROVIDER_LABEL: Record<AccountProvider["provider"], string> = {
  google: "Google",
  microsoft: "Microsoft",
  email: "Email address",
};

/** What the page says about the recorded door. `null` is not "unverified": the account simply has
 *  no record (made before the record existed, or through the API), and the page says so. */
export function describeProvider(p: AccountProvider | null): { label: string; detail: string } {
  if (!p) {
    return { label: "Not recorded", detail: "This account has no sign-in record." };
  }
  const label = PROVIDER_LABEL[p.provider];
  if (p.emailVerified) return { label, detail: "Email address verified" };
  return { label, detail: "Email address not verified" };
}

/** A timestamp for people, or a dash when the core has none. */
export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `/login?notice=<code>` — a code, never text: it selects one of these fixed sentences and is
 *  otherwise ignored. */
export const SIGNED_OUT_EVERYWHERE = "signed-out-everywhere";

export const ACCOUNT_DELETED = "account-deleted";

export function loginNotice(code: string | null): string | null {
  if (code === SIGNED_OUT_EVERYWHERE) return "You've been signed out on every device. Sign in again to continue.";
  if (code === ACCOUNT_DELETED) return "Your account and everything in it has been deleted.";
  return null;
}

/** Does what the person typed name this account? Trimmed and case-insensitive: an email address
 *  is the account's key, not a password, and a stray space or capital must not block a delete
 *  the person means. Used by the dialog (to enable the button) and again by the server (the
 *  check that counts). An empty string never matches. */
export function emailMatches(typed: unknown, actual: string): boolean {
  if (typeof typed !== "string") return false;
  const a = typed.trim().toLowerCase();
  return a.length > 0 && a === actual.trim().toLowerCase();
}

/** What `DELETE /api/account` answers, as a code the view maps to words. `partial` is the one
 *  failure after which the browser is signed out: the core revoked the account's tokens before
 *  the part that failed. */
export type DeleteOutcome = "deleted" | "blocked" | "last_admin" | "partial" | "unavailable";

/** The sentences for each failure — fixed text, never the producer's. */
export const DELETE_FAILURE_TEXT: Record<Exclude<DeleteOutcome, "deleted">, string> = {
  blocked: "Your account can't be deleted right now. Nothing was changed. Try again later, or contact support.",
  last_admin:
    "This is the only administrator account on this deployment, so it can't be deleted. Make another account an administrator first. Nothing was changed.",
  partial:
    "Your account is being deleted, but part of it didn't finish. Sign-in is blocked for this account. Contact support to complete the deletion.",
  unavailable: "We couldn't reach the account service. Nothing was changed. Try again in a moment.",
};
