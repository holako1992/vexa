"use client";
/** The OAuth redirect landing page, shared by every calendar provider the dashboard connects
 *  (Google — DB-31, Microsoft 365 — DB-32/DB-33): reads `code`/`state` (or `error`) off the
 *  query string and relays `{code, state}` to `POST /api/vexa/user/calendars/<provider>/exchange`.
 *
 *  `state` is checked ONLY by the core (`google_oauth.verify_state` / `microsoft_oauth.verify_state`
 *  — signature, TTL, caller binding, single-use; `main.py`'s `google_calendar_exchange` /
 *  `microsoft_calendar_exchange`). This page never invents a second, weaker check of its own: it
 *  reads `state` off the URL and forwards it exactly as the provider echoed it back, the same way
 *  it forwards `code`.
 *
 *  Three distinct failure shapes, each surfaced in the reader's own language rather than folded
 *  into one generic error:
 *   - `error=access_denied` — the person declined the provider's consent screen.
 *   - a missing `code`/`state` — a malformed or replayed redirect.
 *   - the exchange call itself failing — admin-api's own `detail` (state mismatch, an
 *     already-used authorization, the provider rejecting the code, the connection cap, …), shown
 *     verbatim rather than a generic "something went wrong".
 *
 *  One component, one set of tests, one place these three failure shapes are written down —
 *  `src/app/calendar/google/callback/page.tsx` and `src/app/calendar/microsoft/callback/page.tsx`
 *  each render it with their own `provider`, rather than each carrying its own copy.
 */
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { ApiError, mutateJson, presentError } from "@/lib/api";
import { CALENDAR_OAUTH_LABEL, type CalendarOAuthProvider } from "@/lib/calendarOAuth";
import { Button } from "./ui";

export type { CalendarOAuthProvider };

interface ExchangeResult {
  google_email?: string | null;
  microsoft_email?: string | null;
}

type ViewState =
  | { kind: "exchanging" }
  | { kind: "success"; email: string | null }
  | { kind: "error"; message: string };

const PROVIDER_NAME: Record<CalendarOAuthProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** Prefer the producer's own `detail` — admin-api's calendar OAuth routes answer typed, specific
 *  messages ("invalid state: …", "this authorization has already been used", the provider's own
 *  rejection reason, …) — over `presentError`'s generic per-status copy. */
function exchangeErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.detail) return e.detail;
  return presentError(e);
}

export function CalendarOAuthCallback({ provider }: { provider: CalendarOAuthProvider }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<ViewState>({ kind: "exchanging" });
  const label = CALENDAR_OAUTH_LABEL[provider];
  const name = PROVIDER_NAME[provider];

  useEffect(() => {
    let cancelled = false;
    const oauthError = searchParams.get("error");
    const code = searchParams.get("code");
    const authState = searchParams.get("state");

    async function run() {
      if (oauthError) {
        const message =
          oauthError === "access_denied"
            ? `You declined ${name}'s consent screen — no calendar was connected.`
            : `${name} didn't complete sign-in (${oauthError}).`;
        if (!cancelled) setState({ kind: "error", message });
        return;
      }
      if (!code || !authState) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: `${name}'s redirect was missing the authorization code or state.`,
          });
        }
        return;
      }
      try {
        const result = await mutateJson<ExchangeResult>(
          "POST",
          `/api/vexa/user/calendars/${provider}/exchange`,
          { code, state: authState },
        );
        const email = provider === "google" ? result.google_email : result.microsoft_email;
        if (!cancelled) setState({ kind: "success", email: email ?? null });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: exchangeErrorMessage(e) });
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // Runs exactly once per landing on this page. `code`/`state` are single-use at the core
    // (the exchange route's own nonce check) — re-running on a param change would only ever
    // reproduce the same "already used" refusal, never a fresh attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** `?calendar=connected` (success) or `?calendar=1` (an error's "Back to Calendar", another
   *  attempt) — `MeetingsView.tsx`'s landing-page effect reads it and reopens the Calendar tab.
   *  Only the success case also needs `provider`: it is the ONLY one that toasts, and the toast
   *  must name the RIGHT provider — an error already showed its own message on THIS page, so it
   *  never toasts again on the way back. */
  function backToCalendar(param: string) {
    router.push(param === "connected" ? `/?calendar=connected&provider=${provider}` : `/?calendar=${param}`);
  }

  if (state.kind === "exchanging") {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center" role="status">
        <Loader2 className="animate-spin text-ink-3" size={28} aria-hidden />
        <p className="text-sm text-ink-2">Finishing {label} connection…</p>
      </div>
    );
  }

  if (state.kind === "success") {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
        <CheckCircle2 className="text-ok" size={32} aria-hidden />
        <h1 className="text-lg font-semibold">{label} connected</h1>
        <p className="text-sm text-ink-2">
          {state.email
            ? `Vexa can now read events from ${state.email}.`
            : `Vexa can now read your ${label} events.`}
        </p>
        <Button variant="primary" onClick={() => backToCalendar("connected")} className="mt-2">
          Back to Calendar
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <XCircle className="text-live" size={32} aria-hidden />
      <h1 className="text-lg font-semibold">Couldn't connect {label}</h1>
      <p role="alert" className="text-sm text-live">
        {state.message}
      </p>
      <Button variant="secondary" onClick={() => backToCalendar("1")} className="mt-2">
        Back to Calendar
      </Button>
    </div>
  );
}
