"use client";
/** Connect a calendar — the one panel the Add Bot dialog's Calendar tab, the first-run welcome and
 *  the Calendar page all render, so the three never drift apart.
 *
 *  The primary path is one click: Connect Google Calendar / Connect Microsoft 365 (OAuth, through
 *  `useCalendarOAuthConnect`). Under them, "Use another calendar" opens the fallback: the in-app
 *  guide to finding a calendar's secret ICS link (`IcsGuide`), per provider, and the field to paste
 *  it into (`POST /user/calendars`, then a first sync). admin-api's typed 422s land on the field
 *  they name.
 */
import { useCallback, useState } from "react";
import { Calendar, ChevronDown, ChevronUp, Plus } from "lucide-react";
import { ApiError, getJson, mutateJson, presentError } from "@/lib/api";
import type { CalendarReturnTarget } from "@/lib/calendarOAuth";
import { icsGuide, type IcsProviderId } from "@/lib/icsGuide";
import { IcsGuide } from "./IcsGuide";
import { Button, Input, Toggle, useToast } from "./ui";
import { useCalendarOAuthConnect } from "./useCalendarOAuthConnect";

/** admin-api's `calendars.py` validators (`new_connection`/`validate_ics_url`) answer a typed 422
 *  `detail` naming the field that is wrong; anything else is a general error. */
export function classifyCalendarError(e: unknown): { field: "name" | "ics_url" | null; message: string } {
  if (e instanceof ApiError && e.status === 422 && e.detail) {
    const d = e.detail;
    if (d.startsWith("name")) return { field: "name", message: d };
    if (d.startsWith("ics_url") || d.toLowerCase().includes("embed page")) {
      return { field: "ics_url", message: d };
    }
  }
  return { field: null, message: presentError(e) };
}

interface CalendarConnectPanelProps {
  /** Where the Google/Microsoft round-trip lands afterwards; omitted, the meetings page. */
  returnTo?: CalendarReturnTarget | null;
  /** Nothing more can be connected (the per-account cap). */
  disabled?: boolean;
  /** Open the ICS guide straight away (e.g. after an OAuth refusal). */
  defaultIcsOpen?: boolean;
  /** Called before a Google/Microsoft connect starts, so the host can clear its own messages. */
  onOAuthStart?: () => void;
  /** Called once an ICS calendar is connected and its first sync has been asked for. */
  onIcsConnected?: () => void;
  /** Prefix for the form's element ids, unique per page. */
  idPrefix?: string;
}

export function CalendarConnectPanel({
  returnTo = null,
  disabled = false,
  defaultIcsOpen = false,
  onOAuthStart,
  onIcsConnected,
  idPrefix = "cal",
}: CalendarConnectPanelProps) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const { busy: oauthBusy, connect } = useCalendarOAuthConnect(setError, returnTo);

  const [icsOpen, setIcsOpen] = useState(defaultIcsOpen);
  const [provider, setProvider] = useState<IcsProviderId>("google");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [autoJoin, setAutoJoin] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; ics_url?: string }>({});

  const startOAuth = useCallback(
    (p: "google" | "microsoft") => {
      setError(null);
      onOAuthStart?.();
      void connect(p);
    },
    [connect, onOAuthStart],
  );

  const addIcs = useCallback(async () => {
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await mutateJson("POST", "/api/vexa/user/calendars", { name: name.trim(), ics_url: url.trim(), auto_join: autoJoin });
      // The first sync: the newest connection is the one just added.
      const fresh = await getJson<{ calendars?: { id: string }[] }>("/api/vexa/user/calendars");
      const newest = (fresh.calendars ?? []).at(-1);
      if (newest) {
        await mutateJson("POST", `/api/vexa/user/calendars/${encodeURIComponent(newest.id)}/sync`).catch(() => {});
      }
      setName("");
      setUrl("");
      setIcsOpen(false);
      toast.push({ tone: "success", title: "Calendar connected." });
      onIcsConnected?.();
    } catch (e) {
      const { field, message } = classifyCalendarError(e);
      if (field) setFieldErrors({ [field]: message });
      else setError(message);
      toast.push({ tone: "error", title: "Couldn't connect the calendar", description: message });
    } finally {
      setSaving(false);
    }
  }, [name, url, autoJoin, toast, onIcsConnected]);

  return (
    <div className="flex flex-col gap-3" data-testid="calendar-connect-panel">
      {error && (
        <div role="alert" className="rounded-lg border border-live/30 bg-live-soft px-4 py-2.5 text-sm text-live">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          onClick={() => startOAuth("google")}
          loading={oauthBusy === "google"}
          disabled={disabled || oauthBusy === "google"}
          icon={<Calendar size={15} aria-hidden />}
          className="h-10 flex-1"
        >
          {oauthBusy === "google" ? "Opening Google…" : "Connect Google Calendar"}
        </Button>
        <Button
          variant="primary"
          onClick={() => startOAuth("microsoft")}
          loading={oauthBusy === "microsoft"}
          disabled={disabled || oauthBusy === "microsoft"}
          icon={<Calendar size={15} aria-hidden />}
          className="h-10 flex-1"
        >
          {oauthBusy === "microsoft" ? "Opening Microsoft…" : "Connect Microsoft 365"}
        </Button>
      </div>

      <button
        type="button"
        onClick={() => setIcsOpen((open) => !open)}
        disabled={disabled}
        aria-expanded={icsOpen}
        aria-controls={`${idPrefix}-ics-section`}
        className="flex items-center justify-center gap-1.5 self-center text-sm text-ink-3 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
      >
        Use another calendar (Apple, Outlook.com, Proton…) or an ICS link
        {icsOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      </button>

      {icsOpen && (
        <div id={`${idPrefix}-ics-section`} className="flex flex-col gap-4 rounded-xl border border-line bg-raised p-4">
          <IcsGuide provider={provider} onProviderChange={setProvider} />

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <Input
              id={`${idPrefix}-ics-url`}
              label="Paste your calendar's ICS link"
              type="password"
              autoComplete="off"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setFieldErrors((f) => ({ ...f, ics_url: undefined })); }}
              placeholder={icsGuide(provider).placeholder}
              hint="This link lets anyone who has it read your calendar. Vexa keeps it private; you can reset it in your calendar's settings at any time."
              error={fieldErrors.ics_url}
              className="bg-card"
            />
            <Input
              id={`${idPrefix}-ics-name`}
              label="Name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setFieldErrors((f) => ({ ...f, name: undefined })); }}
              placeholder="Work calendar"
              maxLength={100}
              error={fieldErrors.name}
              className="bg-card"
            />
            <Toggle checked={autoJoin} onChange={setAutoJoin} label="Auto-join meetings from this calendar" />
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => void addIcs()}
                disabled={!name.trim() || !url.trim()}
                loading={saving}
                icon={<Plus size={15} aria-hidden />}
              >
                {saving ? "Connecting…" : "Connect calendar"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
