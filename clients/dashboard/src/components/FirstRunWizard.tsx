"use client";
/**
 * The first-run welcome: three steps for an account that has just signed up and has no meetings.
 *
 *   1. Bot name   — what people in the meeting will see. Saved as the person's default bot name
 *                   (`PUT /user/calendar {bot_name}`), the one store a dispatched or calendar-armed
 *                   bot resolves its name from.
 *   2. Calendar   — Connect Google Calendar / Microsoft 365 through the same consent flow the Add
 *                   Bot dialog runs. The page leaves for the provider and comes back through
 *                   `/calendar/<provider>/callback`; `calendarReturn` is how the welcome knows it
 *                   is back and moves on.
 *   3. Meeting    — paste a link and send the bot (`MeetingLinkForm`, the same form the Add Bot
 *                   dialog renders), with the plan's allowance stated before anything is pasted.
 *
 * Where the person is lives at the producer (`PUT /user/first-run`), written on every move, so a
 * refresh — or another browser — resumes the same step. "Skip setup" is on every step and ends the
 * welcome for good; sending the first bot ends it too. Closing the dialog (Escape, the X, a click
 * outside) only hides it for this visit: it is not a decision, so it is not saved.
 *
 * Nothing here is a dead end. A spent or unverified allowance is said in plain words with the way
 * forward, and connecting a calendar stays one click away from the meeting step.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Calendar, Check, CheckCircle2, Sparkles } from "lucide-react";
import clsx from "clsx";
import { getJson, mutateJson, presentError, ApiError } from "@/lib/api";
import { CALENDAR_OAUTH_LABEL, type CalendarOAuthProvider } from "@/lib/calendarOAuth";
import {
  BOT_NAME_MAX,
  FIRST_RUN_STEPS,
  STEP_LABEL,
  type FirstRunStep,
  checkBotName,
  stepIndex,
} from "@/lib/firstRun";
import { Button, Dialog, Input, useToast } from "./ui";
import { MeetingLinkForm, type DispatchedBot } from "./MeetingLinkForm";
import { useCalendarOAuthConnect } from "./useCalendarOAuthConnect";

/** How the page got here, when it came back from a calendar provider: `connected` with the
 *  provider that finished, or `retry` after a failed or declined attempt (the callback page has
 *  already said why). */
export type CalendarReturn = { kind: "connected"; provider: CalendarOAuthProvider } | { kind: "retry" } | null;

export interface FirstRunWizardProps {
  initialStep: FirstRunStep;
  calendarReturn: CalendarReturn;
  /** A bot was sent: reload the meetings list behind the dialog. */
  onBotSent: () => void;
  /** The welcome ended for good (`done` or `skipped`). */
  onEnded: (state: "done" | "skipped") => void;
  /** Hide for this visit; nothing is saved. */
  onClose: () => void;
}

interface ConnectedCalendar {
  id: string;
  kind: string;
  name: string;
  google_email?: string | null;
  microsoft_email?: string | null;
  enabled?: boolean;
}

function calendarLabel(c: ConnectedCalendar): string {
  return c.google_email || c.microsoft_email || c.name;
}

function StepIndicator({ current, onGo, disabled }: { current: FirstRunStep; onGo: (s: FirstRunStep) => void; disabled: boolean }) {
  const at = stepIndex(current);
  return (
    <ol aria-label="Setup steps" className="flex items-center gap-1 border-b border-line px-4 py-3 sm:px-6">
      {FIRST_RUN_STEPS.map((s, i) => {
        const active = i === at;
        const passed = i < at;
        return (
          <li key={s} className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              onClick={() => onGo(s)}
              disabled={disabled}
              aria-current={active ? "step" : undefined}
              className={clsx(
                "flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-xs font-medium transition-colors hover:bg-raised disabled:opacity-60",
                active ? "text-ink" : "text-ink-3",
              )}
            >
              <span
                aria-hidden
                className={clsx(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px]",
                  active && "border-accent bg-accent text-accent-ink",
                  passed && "border-ok/40 bg-ok-soft text-ok",
                  !active && !passed && "border-line",
                )}
              >
                {passed ? <Check size={12} /> : i + 1}
              </span>
              <span className="truncate">
                <span className="sr-only">Step {i + 1}: </span>
                {STEP_LABEL[s]}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function FirstRunWizard({ initialStep, calendarReturn, onBotSent, onEnded, onClose }: FirstRunWizardProps) {
  const toast = useToast();
  const [step, setStep] = useState<FirstRunStep>(calendarReturn?.kind === "connected" ? "meeting" : initialStep);
  const [name, setName] = useState("Vexa");
  const [savedName, setSavedName] = useState("Vexa");
  // Whether the person has typed in the field yet: the saved name, arriving late, must not
  // overwrite what they are in the middle of writing.
  const nameTouched = useRef(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [calendars, setCalendars] = useState<ConnectedCalendar[] | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(
    calendarReturn?.kind === "connected" ? CALENDAR_OAUTH_LABEL[calendarReturn.provider] : null,
  );
  const [sent, setSent] = useState<DispatchedBot | null>(null);
  const { busy: oauthBusy, connect } = useCalendarOAuthConnect(setCalendarError);

  // The person's current default name, so the field starts from what a bot would use today.
  useEffect(() => {
    let cancelled = false;
    getJson<{ bot_name?: unknown }>("/api/vexa/user/calendar")
      .then((d) => {
        if (cancelled) return;
        if (typeof d.bot_name === "string" && d.bot_name) {
          if (!nameTouched.current) setName(d.bot_name);
          setSavedName(d.bot_name);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // The calendars already connected, so a person who comes back to this step sees what they did.
  useEffect(() => {
    if (step !== "calendar") return;
    let cancelled = false;
    getJson<{ calendars?: ConnectedCalendar[] }>("/api/vexa/user/calendars")
      .then((d) => { if (!cancelled) setCalendars((d.calendars ?? []).filter((c) => c.enabled !== false)); })
      .catch(() => { if (!cancelled) setCalendars(null); });
    return () => { cancelled = true; };
  }, [step]);

  /** Write the position. A failure is a toast, not a block: the person is still where they are on
   *  screen, and the worst outcome is that a refresh resumes one step earlier. */
  const saveStep = useCallback(async (next: FirstRunStep) => {
    try {
      await mutateJson("PUT", "/api/vexa/user/first-run", { step: next });
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't save your progress", description: presentError(e) });
    }
  }, [toast]);

  // Back from a calendar provider: say so and move to the last step. Runs once per landing — the
  // OAuth `code` and `state` the callback page spent are single-use at the core.
  const returnHandled = useRef(false);
  useEffect(() => {
    if (calendarReturn?.kind !== "connected" || returnHandled.current) return;
    returnHandled.current = true;
    toast.push({ tone: "success", title: `${CALENDAR_OAUTH_LABEL[calendarReturn.provider]} connected.` });
    setStep("meeting");
    void saveStep("meeting");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Save a changed name, or report why it can't be. True when it is safe to leave the step. */
  const commitName = useCallback(async (): Promise<boolean> => {
    const checked = checkBotName(name);
    if (!checked.ok) {
      setNameError(checked.message);
      return false;
    }
    if (checked.name === savedName) return true;
    try {
      await mutateJson("PUT", "/api/vexa/user/calendar", { bot_name: checked.name });
      setSavedName(checked.name);
      setName(checked.name);
      setNameError(undefined);
      toast.push({ tone: "success", title: `Your bot will join as “${checked.name}”.` });
      return true;
    } catch (e) {
      const msg = presentError(e);
      setNameError(msg);
      toast.push({ tone: "error", title: "Couldn't save the bot's name", description: msg });
      return false;
    }
  }, [name, savedName, toast]);

  const goTo = useCallback(async (target: FirstRunStep) => {
    if (target === step) return;
    setBusy(true);
    try {
      if (step === "name" && !(await commitName())) return;
      await saveStep(target);
      setStep(target);
    } finally {
      setBusy(false);
    }
  }, [step, commitName, saveStep]);

  const end = useCallback(async (state: "done" | "skipped") => {
    setBusy(true);
    try {
      await mutateJson("PUT", "/api/vexa/user/first-run", { state });
    } catch (e) {
      // An account that stopped being new answers 422: nothing is left to end. Anything else is
      // worth a word, but never keeps the person inside a welcome they asked to leave.
      if (!(e instanceof ApiError && e.status === 422)) {
        toast.push({ tone: "error", title: "Couldn't save that you're done", description: presentError(e) });
      }
    } finally {
      setBusy(false);
    }
    onEnded(state);
  }, [onEnded, toast]);

  const onSent = useCallback((bot: DispatchedBot) => {
    setSent(bot);
    onBotSent();
    // Sending the first bot is the welcome's purpose: it ends here, so a refresh does not ask again.
    void end("done");
  }, [onBotSent, end]);

  const index = stepIndex(step);
  const prev = index > 0 ? FIRST_RUN_STEPS[index - 1]! : null;
  const next = index < FIRST_RUN_STEPS.length - 1 ? FIRST_RUN_STEPS[index + 1]! : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Welcome to Vexa"
      description="Three quick steps to your first transcript."
      icon={<Sparkles size={18} aria-hidden />}
      className="w-full max-w-lg rounded-2xl border border-line bg-card shadow-2xl"
    >
      {!sent && <StepIndicator current={step} onGo={(s) => void goTo(s)} disabled={busy} />}

      <div className="max-h-[60vh] overflow-y-auto p-4 sm:p-6">
        {sent ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
            <CheckCircle2 className="text-ok" size={32} aria-hidden />
            <h3 className="text-lg font-semibold">Your bot is joining</h3>
            <p className="text-sm text-ink-2">
              It will start transcribing as soon as it is let in. Open the meeting to watch the
              transcript appear.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {sent.id !== null && (
                <Link
                  href={`/meetings/${encodeURIComponent(String(sent.id))}`}
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90"
                >
                  Open meeting
                </Link>
              )}
              <Button variant="secondary" onClick={onClose}>
                Go to my meetings
              </Button>
            </div>
          </div>
        ) : step === "name" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => { e.preventDefault(); if (next) void goTo(next); }}
          >
            <h3 className="text-base font-semibold">Name your notetaker</h3>
            <p className="text-sm text-ink-2">
              This is the name people see when the bot joins their meeting. You can change it later.
            </p>
            <Input
              id="first-run-bot-name"
              label="Bot name"
              value={name}
              onChange={(e) => { nameTouched.current = true; setName(e.target.value); setNameError(undefined); }}
              maxLength={BOT_NAME_MAX}
              error={nameError}
              autoFocus
            />
            <Button type="submit" variant="primary" loading={busy} className="h-10">
              Continue
            </Button>
          </form>
        ) : step === "calendar" ? (
          <div className="flex flex-col gap-4">
            <h3 className="text-base font-semibold">Connect your calendar</h3>
            <p className="text-sm text-ink-2">
              Vexa joins the meetings on your calendar for you. One click and a consent screen — no
              address to find or paste.
            </p>
            {calendarError && (
              <div role="alert" className="rounded-lg border border-live/30 bg-live-soft px-4 py-2.5 text-sm text-live">
                {calendarError}
              </div>
            )}
            {calendarReturn?.kind === "retry" && !calendarError && (
              <p role="status" className="text-sm text-ink-2">
                The calendar wasn&apos;t connected. You can try again or move on — it is always on the
                Calendar page.
              </p>
            )}
            {(justConnected || (calendars && calendars.length > 0)) && (
              <p role="status" className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok-soft px-4 py-2.5 text-sm text-ok">
                <CheckCircle2 size={15} aria-hidden />
                {justConnected
                  ? `${justConnected} connected.`
                  : `Connected: ${calendars!.map(calendarLabel).join(", ")}.`}
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="primary"
                onClick={() => { setCalendarError(null); setJustConnected(null); void connect("google"); }}
                loading={oauthBusy === "google"}
                disabled={oauthBusy !== null}
                icon={<Calendar size={15} aria-hidden />}
                className="h-10 flex-1"
              >
                {oauthBusy === "google" ? "Opening Google…" : "Connect Google Calendar"}
              </Button>
              <Button
                variant="primary"
                onClick={() => { setCalendarError(null); setJustConnected(null); void connect("microsoft"); }}
                loading={oauthBusy === "microsoft"}
                disabled={oauthBusy !== null}
                icon={<Calendar size={15} aria-hidden />}
                className="h-10 flex-1"
              >
                {oauthBusy === "microsoft" ? "Opening Microsoft…" : "Connect Microsoft 365"}
              </Button>
            </div>
            <p className="text-xs text-ink-3">
              Use a different calendar? Add its secret ICS address later from Add Bot → Calendar.
            </p>
            <Button variant="secondary" onClick={() => next && void goTo(next)} loading={busy} className="h-10">
              {justConnected || (calendars && calendars.length > 0) ? "Continue" : "Continue without a calendar"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <h3 className="text-base font-semibold">Send your bot to a meeting</h3>
            <p className="text-sm text-ink-2">
              Paste the link of a meeting that is happening now, or about to. You will get a live
              transcript.
            </p>
            <MeetingLinkForm
              allowance="above"
              autoFocus={false}
              onSent={onSent}
              whenBlocked={
                <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-raised px-4 py-3 text-center">
                  <p className="text-sm text-ink-2">
                    You can still connect a calendar — it doesn&apos;t need a meeting link.
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => void goTo("calendar")}>
                    Connect a calendar instead
                  </Button>
                </div>
              }
            />
          </div>
        )}
      </div>

      {!sent && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 sm:px-6">
          <Button variant="ghost" size="sm" onClick={() => void end("skipped")} disabled={busy}>
            Skip setup
          </Button>
          {prev && (
            <Button variant="secondary" size="sm" onClick={() => void goTo(prev)} disabled={busy}>
              Back
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}
