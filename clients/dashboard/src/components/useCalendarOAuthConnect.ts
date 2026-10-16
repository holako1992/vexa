"use client";
/** Start a calendar OAuth connect: ask the core for the provider's consent URL, check the host,
 *  and hand the whole page to it.
 *
 *  Shared by `CalendarConnectPanel`'s Connect buttons (the Add Bot dialog, the first-run welcome and
 *  the Calendar page) and every connection row's Reconnect, so all of them run the identical flow — and the trusted-
 *  host check in `lib/calendarOAuth.ts` is never skipped by a caller that re-implemented it.
 *
 *  `busy` names the provider whose flow is in flight, kept per provider so connecting Microsoft 365
 *  never disables the Google button. On success the page is navigating away, so `busy` stays set
 *  rather than flashing back to idle. A failure clears it, reports through `onError` with the
 *  producer's own `detail` when it sent one, and raises an error toast.
 */
import { useCallback, useState } from "react";
import { ApiError, presentError } from "@/lib/api";
import {
  CALENDAR_OAUTH_LABEL,
  type CalendarOAuthProvider,
  type CalendarReturnTarget,
  fetchTrustedAuthorizeUrl,
  rememberCalendarReturn,
} from "@/lib/calendarOAuth";
import { useToast } from "./ui";

/** The message a producer error carries verbatim, when it has one — admin-api's calendar OAuth
 *  routes answer typed, actionable `detail` strings (missing config, the provider's own rejection
 *  reason, a connection-limit refusal, …) that are more useful than `presentError`'s generic
 *  per-status copy. Falls back to `presentError` for a network failure or a response with no
 *  `detail` at all. */
export function oauthErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.detail) return e.detail;
  return presentError(e);
}

/** `returnTo` names where the provider's callback should land afterwards; omitted, the meetings
 *  page (the Add Bot dialog and the first-run welcome). */
export function useCalendarOAuthConnect(onError: (message: string) => void, returnTo: CalendarReturnTarget | null = null) {
  const [busy, setBusy] = useState<CalendarOAuthProvider | null>(null);
  const toast = useToast();

  const connect = useCallback(async (provider: CalendarOAuthProvider) => {
    setBusy(provider);
    const label = CALENDAR_OAUTH_LABEL[provider];
    try {
      const authorizeUrl = await fetchTrustedAuthorizeUrl(provider);
      rememberCalendarReturn(returnTo);
      window.location.assign(authorizeUrl);
    } catch (e) {
      const msg = oauthErrorMessage(e);
      onError(msg);
      toast.push({ tone: "error", title: `Couldn't connect ${label}`, description: msg });
      setBusy(null);
    }
  }, [onError, returnTo, toast]);

  return { busy, connect };
}
