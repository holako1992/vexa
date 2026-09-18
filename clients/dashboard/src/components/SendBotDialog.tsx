"use client";
/**
 * The "Add a Bot" modal — lets the user dispatch a Vexa bot to a live meeting by pasting a URL,
 * or manage ICS calendar connections for automatic join.
 *
 * Two tabs:
 *   • "Meeting link" — paste a Google Meet / Zoom / Teams / Jitsi URL, see live parse feedback,
 *     then send the bot.
 *   • "Calendar" — list connected ICS calendars, toggle auto-join, sync, connect new, disconnect.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Calendar, Check, ChevronDown, ChevronUp, Link2, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { getJson, mutateJson, presentError, ApiError } from "@/lib/api";
import { parseMeetingInput, type ParsedMeeting } from "@/lib/meetingId";

// ─── types ───────────────────────────────────────────────────────────────────

interface CalendarConnection {
  id: string;
  name: string;
  ics_url_set: boolean;
  ics_url_masked?: string | null;
  auto_join: boolean;
  bot_name?: string | null;
  enabled: boolean;
}

interface BotSendPayload {
  platform: string;
  native_meeting_id: string;
  meeting_url?: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  jitsi: "Jitsi",
};

const PLATFORM_COLORS: Record<string, string> = {
  google_meet: "bg-ok-soft text-ok",
  zoom: "bg-accent-soft text-accent",
  teams: "bg-accent-soft text-accent",
  jitsi: "bg-warn-soft text-warn",
};

// ─── small shared pieces ─────────────────────────────────────────────────────

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

// ─── Meeting-link tab ─────────────────────────────────────────────────────────

function MeetingLinkTab({ onSent }: { onSent: () => void }) {
  const [url, setUrl] = useState("");
  const [parsed, setParsed] = useState<ParsedMeeting | null>(null);
  const [jitsiHosts, setJitsiHosts] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    getJson<{ hosts?: string[] }>("/api/vexa/meeting/jitsi-hosts")
      .then((d) => setJitsiHosts(Array.isArray(d.hosts) ? d.hosts : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setParsed(parseMeetingInput(url, jitsiHosts));
    setResult(null);
  }, [url, jitsiHosts]);

  const send = useCallback(async () => {
    if (!parsed) return;
    setSending(true);
    setResult(null);
    const payload: BotSendPayload = {
      platform: parsed.platform,
      native_meeting_id: parsed.native_meeting_id,
      meeting_url: url.trim() || undefined,
    };
    try {
      await mutateJson("POST", "/api/vexa/bots", payload);
      setResult({ ok: true, msg: "Bot is joining the meeting." });
      setUrl("");
      onSent();
    } catch (e) {
      setResult({ ok: false, msg: presentError(e) });
    } finally {
      setSending(false);
    }
  }, [parsed, url, onSent]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <label htmlFor="meeting-url-input" className="mb-1.5 block text-sm font-medium">
          Meeting URL
        </label>
        <input
          id="meeting-url-input"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && parsed && !sending) void send(); }}
          placeholder="https://meet.google.com/abc-defg-hij"
          autoFocus
          className="w-full rounded-lg border border-line bg-raised px-3.5 py-2.5 text-sm placeholder:text-ink-3 focus:border-accent focus:outline-none"
        />

        {/* Live parse feedback */}
        <div className="mt-2 h-5 text-xs">
          {parsed ? (
            <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium", PLATFORM_COLORS[parsed.platform] ?? "bg-raised text-ink-2")}>
              <Check size={11} aria-hidden />
              {PLATFORM_LABELS[parsed.platform] ?? parsed.platform}
              <span className="opacity-70">· {parsed.native_meeting_id}</span>
            </span>
          ) : url ? (
            <span className="text-ink-3">Paste a Google Meet, Zoom, Teams, or Jitsi link.</span>
          ) : null}
        </div>
      </div>

      {result && (
        <div
          role="status"
          className={clsx(
            "rounded-lg border px-4 py-2.5 text-sm",
            result.ok
              ? "border-ok/30 bg-ok-soft text-ok"
              : "border-live/30 bg-live-soft text-live",
          )}
        >
          {result.msg}
        </div>
      )}

      <button
        type="button"
        onClick={send}
        disabled={!parsed || sending}
        className={clsx(
          "flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors",
          parsed && !sending
            ? "bg-accent text-accent-ink hover:opacity-90"
            : "cursor-not-allowed bg-raised text-ink-3",
        )}
      >
        {sending ? (
          <><Loader2 size={15} className="animate-spin" aria-hidden /> Sending…</>
        ) : (
          <><Bot size={15} aria-hidden /> Send Bot</>
        )}
      </button>

      <p className="text-center text-xs text-ink-3">
        The bot will join the meeting and begin transcribing. It appears in the meeting as "Vexa".
      </p>
    </div>
  );
}

// ─── Calendar tab ─────────────────────────────────────────────────────────────

interface CalendarRowProps {
  cal: CalendarConnection;
  onDelete: (id: string) => void;
  onPatch: (id: string, body: Partial<CalendarConnection>) => void;
  onSync: (id: string) => void;
  busy: boolean;
}

function CalendarRow({ cal, onDelete, onPatch, onSync, busy }: CalendarRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-xl border border-line bg-card">
      {/* Summary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-2">
          <Calendar size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{cal.name}</p>
          <p className="text-xs text-ink-3">
            {cal.ics_url_masked ? `Feed: ${cal.ics_url_masked}` : "No feed set"}
            {" · "}
            {cal.auto_join ? "Auto-join on" : "Auto-join off"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Sync calendar"
            disabled={busy}
            onClick={() => onSync(cal.id)}
            className="rounded-lg p-1.5 text-ink-2 transition-colors hover:bg-raised disabled:opacity-40"
          >
            <RefreshCw size={14} aria-hidden />
          </button>
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
          <label className="flex cursor-pointer items-center gap-2.5">
            <span
              role="checkbox"
              aria-checked={cal.auto_join}
              tabIndex={0}
              onClick={() => onPatch(cal.id, { auto_join: !cal.auto_join })}
              onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") onPatch(cal.id, { auto_join: !cal.auto_join }); }}
              className={clsx(
                "flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                cal.auto_join ? "bg-accent" : "bg-raised",
              )}
            >
              <span className={clsx(
                "ml-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                cal.auto_join ? "translate-x-4" : "translate-x-0",
              )} />
            </span>
            <span className="text-sm text-ink-2">Auto-join meetings from this calendar</span>
          </label>

          {/* Disconnect */}
          <div className="mt-3 flex items-center gap-2">
            {confirmDelete ? (
              <>
                <span className="flex-1 text-xs text-ink-3">
                  Remove this calendar? Meetings it imported will be unlinked.
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg border border-line px-3 py-1 text-xs text-ink-2 hover:bg-raised"
                >Cancel</button>
                <button
                  type="button"
                  onClick={() => onDelete(cal.id)}
                  disabled={busy}
                  className="rounded-lg bg-live px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                >Remove</button>
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
  const [busy, setBusy] = useState<string | null>(null); // the id being mutated, or "new"
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newAutoJoin, setNewAutoJoin] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await getJson<{ calendars?: CalendarConnection[] }>("/api/vexa/user/calendars");
      setCalendars(d.calendars ?? []);
      setError(null);
    } catch (e) {
      setError(presentError(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await mutateJson("DELETE", `/api/vexa/user/calendars/${encodeURIComponent(id)}`);
      await load();
    } catch (e) {
      setError(presentError(e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const handlePatch = useCallback(async (id: string, body: Partial<CalendarConnection>) => {
    setBusy(id);
    try {
      await mutateJson("PATCH", `/api/vexa/user/calendars/${encodeURIComponent(id)}`, body);
      await load();
    } catch (e) {
      setError(presentError(e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const handleSync = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await mutateJson("POST", `/api/vexa/user/calendars/${encodeURIComponent(id)}/sync`);
      await load();
    } catch (e) {
      setError(presentError(e));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    setBusy("new");
    setError(null);
    try {
      await mutateJson("POST", "/api/vexa/user/calendars", {
        name: newName.trim(),
        ics_url: newUrl.trim(),
        auto_join: newAutoJoin,
      });
      setNewName("");
      setNewUrl("");
      setShowAdd(false);
      await load();
      // Trigger a sync on the newly-connected calendar
      const fresh = await getJson<{ calendars?: CalendarConnection[] }>("/api/vexa/user/calendars");
      const newest = (fresh.calendars ?? []).at(-1);
      if (newest) await mutateJson("POST", `/api/vexa/user/calendars/${encodeURIComponent(newest.id)}/sync`).catch(() => {});
      await load();
    } catch (e) {
      setError(presentError(e));
    } finally {
      setBusy(null);
    }
  }, [newName, newUrl, newAutoJoin, load]);

  const canAdd = (calendars?.length ?? 0) < 10;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="rounded-lg border border-live/30 bg-live-soft px-4 py-2.5 text-sm text-live">
          {error}
        </div>
      )}

      {calendars === null && !error && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink-3">
          <Loader2 size={15} className="animate-spin" aria-hidden /> Loading…
        </div>
      )}

      {calendars !== null && calendars.length === 0 && !showAdd && (
        <div className="rounded-xl border border-dashed border-line py-8 text-center">
          <Calendar size={28} className="mx-auto mb-2 text-ink-3" aria-hidden />
          <p className="text-sm font-medium text-ink-2">No calendars connected</p>
          <p className="mt-0.5 text-xs text-ink-3">
            Connect an ICS feed and Vexa will auto-join meetings for you.
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
              busy={busy === cal.id}
            />
          ))}
        </div>
      )}

      {/* Add form */}
      {showAdd ? (
        <div className="rounded-xl border border-line bg-raised p-4">
          <p className="mb-3 text-sm font-semibold">Connect a calendar</p>
          <div className="flex flex-col gap-3">
            <div>
              <label htmlFor="cal-name" className="mb-1 block text-xs font-medium text-ink-2">Name</label>
              <input
                id="cal-name"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Work calendar"
                maxLength={100}
                className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="cal-ics" className="mb-1 block text-xs font-medium text-ink-2">
                Secret ICS address
              </label>
              <input
                id="cal-ics"
                type="password"
                autoComplete="off"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://calendar.google.com/…/basic.ics"
                className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={newAutoJoin}
                onChange={(e) => setNewAutoJoin(e.target.checked)}
                className="h-4 w-4 rounded border-line accent-accent"
              />
              Auto-join meetings from this calendar
            </label>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-line px-4 py-2 text-sm text-ink-2 hover:bg-card"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newName.trim() || !newUrl.trim() || busy === "new"}
              className={clsx(
                "flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                newName.trim() && newUrl.trim() && busy !== "new"
                  ? "bg-accent text-accent-ink hover:opacity-90"
                  : "cursor-not-allowed bg-raised text-ink-3",
              )}
            >
              {busy === "new" ? <><Loader2 size={13} className="animate-spin" /> Connecting…</> : "Connect"}
            </button>
          </div>
        </div>
      ) : canAdd && (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line py-3 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          <Plus size={15} aria-hidden /> Connect a calendar
        </button>
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
}

export function SendBotDialog({ onClose, onBotSent }: SendBotDialogProps) {
  const [tab, setTab] = useState<TabId>("link");
  const backdropRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-bot-dialog-title"
        className="w-full max-w-lg rounded-2xl border border-line bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Bot size={18} aria-hidden />
          </span>
          <div>
            <h2 id="send-bot-dialog-title" className="text-[15px] font-semibold">Add a Vexa Bot</h2>
            <p className="text-xs text-ink-3">Paste a meeting link or connect a calendar for auto-join.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-lg p-1.5 text-ink-2 transition-colors hover:bg-raised"
          >
            <X size={17} aria-hidden />
          </button>
        </div>

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
          {tab === "link" && <MeetingLinkTab onSent={onBotSent} />}
          {tab === "calendar" && <CalendarTab />}
        </div>
      </div>
    </div>
  );
}
