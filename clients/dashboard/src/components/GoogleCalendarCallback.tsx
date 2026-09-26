"use client";
/** DB-31 — Google's redirect lands here after the consent screen: `/calendar/google/callback`,
 *  reading `code`/`state` (or `error`) off the query string and relaying `{code, state}` to
 *  `POST /api/vexa/user/calendars/google/exchange`.
 *
 *  `state` is checked ONLY by the core (`google_oauth.verify_state` — signature, TTL, caller
 *  binding, single-use; `main.py`'s `google_calendar_exchange`). This page never invents a
 *  second, weaker check of its own: it reads `state` off the URL and forwards it exactly as
 *  Google echoed it back, the same way it forwards `code`.
 *
 *  Three distinct failure shapes, each surfaced in the reader's language rather than folded into
 *  one generic error:
 *   - `error=access_denied` — the person declined Google's consent screen.
 *   - a missing `code`/`state` — a malformed or replayed redirect.
 *   - the exchange call itself failing — admin-api's own `detail` (state mismatch, an
 *     already-used authorization, Google rejecting the code, the connection cap, …), shown
 *     verbatim rather than a generic "something went wrong".
 */
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { ApiError, mutateJson, presentError } from "@/lib/api";
import { Button } from "./ui";

interface ExchangeResult {
  google_email?: string | null;
}

type ViewState =
  | { kind: "exchanging" }
  | { kind: "success"; email: string | null }
  | { kind: "error"; message: string };

/** Prefer the producer's own `detail` — admin-api's Google routes answer typed, specific
 *  messages ("invalid state: …", "this authorization has already been used", "Google rejected
 *  the authorization code: …") — over `presentError`'s generic per-status copy. */
function exchangeErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.detail) return e.detail;
  return presentError(e);
}

export function GoogleCalendarCallback() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<ViewState>({ kind: "exchanging" });

  useEffect(() => {
    let cancelled = false;
    const oauthError = searchParams.get("error");
    const code = searchParams.get("code");
    const authState = searchParams.get("state");

    async function run() {
      if (oauthError) {
        const message =
          oauthError === "access_denied"
            ? "You declined Google's consent screen — no calendar was connected."
            : `Google didn't complete sign-in (${oauthError}).`;
        if (!cancelled) setState({ kind: "error", message });
        return;
      }
      if (!code || !authState) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: "Google's redirect was missing the authorization code or state.",
          });
        }
        return;
      }
      try {
        const result = await mutateJson<ExchangeResult>(
          "POST",
          "/api/vexa/user/calendars/google/exchange",
          { code, state: authState },
        );
        if (!cancelled) setState({ kind: "success", email: result.google_email ?? null });
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

  function backToCalendar(param: string) {
    router.push(`/?calendar=${param}`);
  }

  if (state.kind === "exchanging") {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center" role="status">
        <Loader2 className="animate-spin text-ink-3" size={28} aria-hidden />
        <p className="text-sm text-ink-2">Finishing Google Calendar connection…</p>
      </div>
    );
  }

  if (state.kind === "success") {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
        <CheckCircle2 className="text-ok" size={32} aria-hidden />
        <h1 className="text-lg font-semibold">Google Calendar connected</h1>
        <p className="text-sm text-ink-2">
          {state.email
            ? `Vexa can now read events from ${state.email}.`
            : "Vexa can now read your Google Calendar events."}
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
      <h1 className="text-lg font-semibold">Couldn't connect Google Calendar</h1>
      <p role="alert" className="text-sm text-live">
        {state.message}
      </p>
      <Button variant="secondary" onClick={() => backToCalendar("1")} className="mt-2">
        Back to Calendar
      </Button>
    </div>
  );
}
