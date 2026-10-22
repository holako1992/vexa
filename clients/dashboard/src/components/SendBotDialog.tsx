"use client";
/**
 * The "Add a Bot" modal — lets the user dispatch a Vexa bot to a live meeting by pasting a URL,
 * or connect and manage calendars for automatic join.
 *
 * Two tabs:
 *   • "Meeting link" — paste a Google Meet / Zoom / Teams / Jitsi URL, see live parse feedback,
 *     then send the bot.
 *   • "Calendar" — connect a calendar (`CalendarConnectPanel`: Google, Microsoft 365, or an ICS
 *     link with the in-app guide), then list connections: toggle auto-join, sync, reconnect,
 *     disconnect.
 *
 * Built on the shared primitives in `./ui`: `Dialog` (focus trap, Escape, backdrop click, focus
 * return — the one `role="dialog"` here) and `Toggle` (a real `role="switch"` for auto-join,
 * not a hand-rolled `<span role="checkbox">`).
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Calendar,
  ChevronDown,
  ChevronUp,
  Link2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import clsx from "clsx";
import { getJson, mutateJson, presentError } from "@/lib/api";
import { Button, Dialog, Toggle, useToast } from "./ui";
import { MeetingLinkForm } from "./MeetingLinkForm";
import { useCalendarOAuthConnect } from "./useCalendarOAuthConnect";
import { CalendarConnectPanel } from "./CalendarConnectPanel";

// ─── types ───────────────────────────────────────────────────────────────────

interface CalendarConnection {
  id: string;
  /** `masked_connection` (`admin_api/app/calendars.py`) always sets this, defaulting a connection
   *  row with no stored `kind` to `"ics"` server-side — never missing on the wire. */
  kind: "ics" | "google" | "microsoft";
  name: string;
  ics_url_set?: boolean;
  ics_url_masked?: string | null;
  /** Google-only fields — never present on any other `kind`. */
  google_email?: string | null;
  google_calendar_ids?: string[];
  /** Microsoft-only fields — never present on any other `kind`. */
  microsoft_email?: string | null;
  microsoft_calendar_ids?: string[];
  reconnect_needed?: boolean;
  auto_join: boolean;
  bot_name?: string | null;
  enabled: boolean;
}

// ─── small shared pieces ─────────────────────────────────────────────────────

/** The link/calendar switcher. Deliberately plain buttons, not the `Tabs` ARIA pattern — these
 *  two panels are full, independent forms rather than views over the same data, and nothing here
 *  needs arrow-key roving between them. */
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors",
        active ? "border-accent text-accent" : "border-transparent text-ink-3 hover:text-ink-2",
      )}
    >
      {children}
    </button>
  );
}

// ─── Calendar tab ─────────────────────────────────────────────────────────────

interface CalendarRowProps {
  cal: CalendarConnection;
  onDelete: (id: string) => void;
  onPatch: (id: string, body: Partial<CalendarConnection>) => void;
  onSync: (id: string) => void;
  onReconnect: (cal: CalendarConnection) => void;
  busy: boolean;
  reconnecting: boolean;
}

/** Both OAuth connection kinds (`"google"`, `"microsoft"`) get the identical reconnect treatment
 *  — see `masked_connection`/`set_reconnect_needed` (`calendars.py`), which apply the SAME
 *  `reconnect_needed` flag to either kind. */
const OAUTH_KINDS = new Set(["google", "microsoft"]);

function CalendarRow({ cal, onDelete, onPatch, onSync, onReconnect, busy, reconnecting }: CalendarRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const needsReconnect = OAUTH_KINDS.has(cal.kind) && !!cal.reconnect_needed;

  return (
    <div className={clsx("rounded-xl border bg-card", needsReconnect ? "border-warn/40" : "border-line")}>
      {/* Summary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-2">
          <Calendar size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{cal.name}</p>
          <p className="text-xs text-ink-3">
            {cal.kind === "google"
              ? (cal.google_email ?? "Google Calendar")
              : cal.kind === "microsoft"
                ? (cal.microsoft_email ?? "Microsoft 365")
                : (cal.ics_url_masked ? `Feed: ${cal.ics_url_masked}` : "No feed set")}
            {" · "}
            {cal.auto_join ? "Auto-join on" : "Auto-join off"}
          </p>
          {needsReconnect && (
            <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-warn">
              <AlertTriangle size={11} aria-hidden /> Reconnect needed —{" "}
              {cal.kind === "microsoft" ? "Microsoft" : "Google"} access was revoked or expired.
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {needsReconnect ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onReconnect(cal)}
              loading={reconnecting}
              disabled={reconnecting}
            >
              Reconnect
            </Button>
          ) : cal.kind === "ics" && (
            <button
              type="button"
              aria-label="Sync calendar"
              disabled={busy}
              onClick={() => onSync(cal.id)}
              className="rounded-lg p-1.5 text-ink-2 transition-colors hover:bg-raised disabled:opacity-40"
            >
              <RefreshCw size={14} aria-hidden />
            </button>
          )}
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg p-1.5 text-ink-2 transition-colors hover:bg-raised"
          >
            {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          </button>
        </div>
      </div>

      {/* Expanded controls */}
      {expanded && (
        <div className="border-t border-line px-4 py-3 text-sm">
          <Toggle
            checked={cal.auto_join}
            onChange={(checked) => onPatch(cal.id, { auto_join: checked })}
            label="Auto-join meetings from this calendar"
          />

          {/* Disconnect */}
          <div className="mt-3 flex items-center gap-2">
            {confirmDelete ? (
              <>
                <span className="flex-1 text-xs text-ink-3">
                  Remove this calendar? Meetings it imported will be unlinked.
                </span>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" onClick={() => onDelete(cal.id)} disabled={busy}>
                  Remove
                </Button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-live hover:bg-live-soft"
              >
                <Trash2 size={12} aria-hidden /> Disconnect
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CalendarTab() {
  const [calendars, setCalendars] = useState<CalendarConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The roster read failed: "could not ask", kept apart from a failed action on one row.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the id being mutated
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const d = await getJson<{ calendars?: CalendarConnection[] }>("/api/vexa/user/calendars");
      setCalendars(d.calendars ?? []);
      setError(null);
      setLoadError(null);
    } catch (e) {
      setLoadError(presentError(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await mutateJson("DELETE", `/api/vexa/user/calendars/${encodeURIComponent(id)}`);
      await load();
      toast.push({ tone: "success", title: "Calendar removed." });
    } catch (e) {
      const msg = presentError(e);
      setError(msg);
      toast.push({ tone: "error", title: "Couldn't remove the calendar", description: msg });
    } finally {
      setBusy(null);
    }
  }, [load, toast]);

  const handlePatch = useCallback(async (id: string, body: Partial<CalendarConnection>) => {
    setBusy(id);
    try {
      await mutateJson("PATCH", `/api/vexa/user/calendars/${encodeURIComponent(id)}`, body);
      await load();
      toast.push({ tone: "success", title: "Calendar updated." });
    } catch (e) {
      const msg = presentError(e);
      setError(msg);
      toast.push({ tone: "error", title: "Couldn't update the calendar", description: msg });
    } finally {
      setBusy(null);
    }
  }, [load, toast]);

  const handleSync = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await mutateJson("POST", `/api/vexa/user/calendars/${encodeURIComponent(id)}/sync`);
      await load();
      toast.push({ tone: "success", title: "Calendar synced." });
    } catch (e) {
      const msg = presentError(e);
      setError(msg);
      toast.push({ tone: "error", title: "Couldn't sync the calendar", description: msg });
    } finally {
      setBusy(null);
    }
  }, [load, toast]);

  /** The Connect buttons and every row's "Reconnect" run the same consent flow — a reconnect is
   *  exactly a connect, run again; the core matches the returning account by email and clears
   *  `reconnect_needed` on that same connection (`main.py`'s `google_calendar_exchange` /
   *  `microsoft_calendar_exchange`), so this client never needs to say WHICH connection it's
   *  reconnecting. `oauthBusy` is per provider, so a row's "Reconnect" spinner reflects ONLY its
   *  own provider. */
  const { busy: oauthBusy, connect } = useCalendarOAuthConnect(setError);
  const connectOAuth = useCallback((provider: "google" | "microsoft") => {
    setError(null);
    return connect(provider);
  }, [connect]);

  const canAdd = (calendars?.length ?? 0) < 10;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="rounded-lg border border-live/30 bg-live-soft px-4 py-2.5 text-sm text-live">
          {error}
        </div>
      )}

      <CalendarConnectPanel disabled={!canAdd} onOAuthStart={() => setError(null)} onIcsConnected={() => void load()} idPrefix="dialog-cal" />

      {calendars === null && !loadError && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-3" role="status">
          Loading…
        </div>
      )}

      {calendars === null && loadError && (
        <div role="alert" className="rounded-xl border border-live/30 bg-live-soft px-4 py-4 text-center text-sm text-live">
          <p>Couldn&apos;t load your connected calendars. {loadError}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()} icon={<RefreshCw size={13} aria-hidden />}>
            Try again
          </Button>
        </div>
      )}

      {calendars !== null && calendars.length === 0 && (
        <div className="rounded-xl border border-dashed border-line py-6 text-center">
          <Calendar size={24} className="mx-auto mb-2 text-ink-3" aria-hidden />
          <p className="text-sm font-medium text-ink-2">No calendars connected</p>
          <p className="mt-0.5 text-xs text-ink-3">
            Connect one above and Vexa will auto-join its meetings for you.
          </p>
        </div>
      )}

      {calendars !== null && calendars.length > 0 && (
        <div className="flex flex-col gap-2">
          {calendars.map((cal) => (
            <CalendarRow
              key={cal.id}
              cal={cal}
              onDelete={handleDelete}
              onPatch={handlePatch}
              onSync={handleSync}
              onReconnect={(row) => void connectOAuth(row.kind === "microsoft" ? "microsoft" : "google")}
              busy={busy === cal.id}
              reconnecting={oauthBusy === (cal.kind === "microsoft" ? "microsoft" : "google")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dialog shell ─────────────────────────────────────────────────────────────

type TabId = "link" | "calendar";

interface SendBotDialogProps {
  onClose: () => void;
  /** Called after a bot is successfully sent, so the meeting list can reload. */
  onBotSent: () => void;
  /** Which tab opens first. Defaults to "link" — `MeetingsView` passes "calendar" when the
   * dialog is being reopened after returning from Google's OAuth consent screen, so the
   *  person lands back where they started instead of the meeting-link tab. */
  initialTab?: TabId;
}

export function SendBotDialog({ onClose, onBotSent, initialTab = "link" }: SendBotDialogProps) {
  const [tab, setTab] = useState<TabId>(initialTab);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a Vexa Bot"
      description="Paste a meeting link or connect a calendar for auto-join."
      icon={<Bot size={18} aria-hidden />}
      className="w-full max-w-lg rounded-2xl border border-line bg-card shadow-2xl"
    >
      {/* Tabs */}
      <div className="flex gap-5 border-b border-line px-6 pt-4">
        <TabButton active={tab === "link"} onClick={() => setTab("link")}>
          <Link2 size={14} aria-hidden /> Meeting link
        </TabButton>
        <TabButton active={tab === "calendar"} onClick={() => setTab("calendar")}>
          <Calendar size={14} aria-hidden /> Calendar
        </TabButton>
      </div>

      {/* Body */}
      <div className="max-h-[60vh] overflow-y-auto p-6">
        {tab === "link" && <MeetingLinkForm onSent={() => onBotSent()} />}
        {tab === "calendar" && <CalendarTab />}
      </div>
    </Dialog>
  );
}
