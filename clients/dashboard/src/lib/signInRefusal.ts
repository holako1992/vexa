/** Why a sign-in was refused, as a closed set of codes with fixed copy.
 *
 *  admin-api answers a refused sign-up with a typed body; the server side reduces it to one of
 *  these codes, and `/login` turns a code back into words. Nothing between the two carries free
 *  text, so a crafted `/login?error=...` link can only ever select one of the strings below — it
 *  cannot put its own words on the page.
 *
 *  Client-safe: no server imports, so the login card can use it directly.
 */

export const REFUSAL_MESSAGES = {
  disposable_email_domain:
    "That email domain is a disposable or throwaway provider and can't be used to sign up. Use a permanent email address.",
  sign_in_failed: "We couldn't sign you in with that account. Try again, or use a different one.",
  unavailable: "Sign-in is temporarily unavailable. Try again in a moment.",
} as const;

export type RefusalCode = keyof typeof REFUSAL_MESSAGES;

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REFUSAL_MESSAGES, value);
}

/** The words for a `?error=` / `code` value, or null when there is nothing to show. A known code
 *  gets its own copy; any other non-empty value (NextAuth's own error names, a hand-typed link)
 *  gets the generic sign-in message — never the value itself. */
export function refusalMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  return isRefusalCode(value) ? REFUSAL_MESSAGES[value] : REFUSAL_MESSAGES.sign_in_failed;
}

/** A refusal read off admin-api's response, carrying the code `/login` maps to words. */
export class SignInRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, detail?: string) {
    super(detail || code);
    this.name = "SignInRefusal";
    this.code = code;
  }
}

/** Reduce an admin-api failure to a refusal. admin-api's typed refusals arrive as FastAPI's
 *  `{"detail": {"error": "<code>", ...}}`; a client-error status with no recognised code is a
 *  generic refusal, and anything else (network, timeout, 5xx, not configured) is `unavailable`. */
export function refusalFromAdmin(status: number, body: string | undefined): SignInRefusal {
  if (status >= 400 && status < 500) {
    let code: unknown;
    try {
      const parsed = JSON.parse(body || "") as { detail?: { error?: unknown } } | null;
      code = parsed?.detail?.error;
    } catch {
      code = undefined;
    }
    return new SignInRefusal(isRefusalCode(code) && code !== "unavailable" ? code : "sign_in_failed", body);
  }
  return new SignInRefusal("unavailable", body);
}
