/** The one place both calendar OAuth providers' shared shape lives, so `SendBotDialog`'s connect
 *  buttons, `CalendarOAuthCallback`'s landing page, and `CalendarHealthView`'s Reconnect action
 *  agree on the provider id, its display label, and — the part worth never duplicating — the
 *  authorize-URL host check each of them must run before ever navigating a signed-in user's
 *  browser there.
 */
import { getJson } from "./api";
import { isTrustedGoogleAuthorizeRedirect, isTrustedMicrosoftAuthorizeRedirect } from "./security";

export type CalendarOAuthProvider = "google" | "microsoft";

export const CALENDAR_OAUTH_LABEL: Record<CalendarOAuthProvider, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft 365",
};

interface OAuthAuthorizeResponse {
  authorize_url: string;
  state: string;
}

/** `GET /user/calendars/<provider>/authorize` → the validated `authorize_url`, or a throw with a
 *  reader-facing message when the response's host isn't the provider's real consent screen
 *  (`isTrustedGoogleAuthorizeRedirect` / `isTrustedMicrosoftAuthorizeRedirect`, `lib/security.ts`)
 *  — every caller of this function gets that guard for free instead of re-implementing it. The
 *  caller still owns `state`/loading/error UI; this only resolves the one URL. */
export async function fetchTrustedAuthorizeUrl(provider: CalendarOAuthProvider): Promise<string> {
  const { authorize_url } = await getJson<OAuthAuthorizeResponse>(
    `/api/vexa/user/calendars/${provider}/authorize`,
  );
  const trusted = provider === "google"
    ? isTrustedGoogleAuthorizeRedirect(authorize_url)
    : isTrustedMicrosoftAuthorizeRedirect(authorize_url);
  if (!trusted) {
    throw new Error(
      `${CALENDAR_OAUTH_LABEL[provider]} returned an unexpected link. Please try again, or contact support.`,
    );
  }
  return authorize_url;
}
