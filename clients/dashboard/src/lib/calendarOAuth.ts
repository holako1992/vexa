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

/** Where a calendar OAuth round-trip should land once the provider sends the browser back. The
 *  default landing is the meetings page (the Add Bot dialog and the first-run welcome both live
 *  there); the Calendar page asks to come back to itself. One fixed value, so the callback never
 *  navigates to a path it did not choose. */
export type CalendarReturnTarget = "/calendar";

const RETURN_KEY = "vexa.calendar-oauth-return";

export function rememberCalendarReturn(target: CalendarReturnTarget | null): void {
  try {
    if (target) window.sessionStorage.setItem(RETURN_KEY, target);
    else window.sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Storage unavailable: the callback falls back to the meetings page.
  }
}

/** Read and forget the remembered landing; `null` means the meetings page. */
export function takeCalendarReturn(): CalendarReturnTarget | null {
  try {
    const value = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    return value === "/calendar" ? "/calendar" : null;
  } catch {
    return null;
  }
}
