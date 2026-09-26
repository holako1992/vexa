"use client";
/** `/upcoming` (DB-33): the meetings Vexa is watching for, grouped by day.
 *
 *  The core owns the read: `GET /meetings` (already the list page's own source — DB-01/DB-48)
 *  returns every planned row a caller can see, calendar-synced or hand-scheduled alike, in one
 *  call. This view applies the SAME phase filter `MeetingsView`'s own "Upcoming" tab already
 *  applies (`lib/meetings.ts`'s `phaseOf`, `"scheduled"`) — it is not a second source, and not a
 *  client-side merge across endpoints; it is one read, grouped and enriched for its own page.
 *
 *  Per meeting:
 *   - the source calendar chip (`data.calendar_name`, absent for a hand-scheduled plan)
 *   - the Join / Don't join override — a real `Toggle` bound to `data.auto_join`, written through
 *     `PATCH /api/vexa/meetings/<id> {auto_join}` (DB-33; `upstream.ts`'s narrow `isAutoJoinBody`
 *     allowlist entry — see that file's comment for why this is PATCH on the row id, not `PUT
 *     .../intent`, which sets an unrelated FSM-external status and cannot express a join/skip
 *     decision at all)
 *   - the producer's own auto-join skip/failure reason (`data.auto_join_error`,
 *     `bot_spawn/auto_join.py`), shown verbatim, never reworded
 *
 *  "Sync now" runs the existing per-connection sync (`POST /user/calendars/<id>/sync`, DB-31's
 *  Calendar tab) across every connected calendar, then reloads the list — the same action already
 *  in the Calendar tab, offered here too since this is where its result shows up.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, RefreshCw } from "lucide-react";
import { getJson, mutateJson, presentError } from "@/lib/api";
import { type Meeting, type MeetingsPageDTO, groupUpcomingByDay, toMeeting } from "@/lib/meetings";
import { Button, Toggle, useToast } from "./ui";
import { EmptyState, ErrorState, LoadingState } from "./EmptyState";

/** Just enough of `GET /user/calendars`' rows to drive "Sync now" — every connection's id, kind
 *  is not read here, so it works for ICS, Google and Microsoft connections alike. */
interface CalendarConnectionLite {
  id: string;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; meetings: Meeting[] };

export function UpcomingView() {
  const toast = useToast();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [calendars, setCalendars] = useState<CalendarConnectionLite[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getJson<MeetingsPageDTO>("/api/vexa/meetings");
      const scheduled = (data.meetings ?? []).map(toMeeting).filter((m) => m.phase === "scheduled");
      setState({ kind: "loaded", meetings: scheduled });
    } catch (e) {
      setState({ kind: "error", message: presentError(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Best-effort: the page (and "Sync now") still work with no connection roster loaded — it
    // only means "Sync now" has nothing to iterate yet.
    getJson<{ calendars?: CalendarConnectionLite[] }>("/api/vexa/user/calendars")
      .then((d) => setCalendars(d.calendars ?? []))
      .catch(() => {});
  }, []);

  const syncNow = useCallback(async () => {
    if (calendars.length === 0) {
      toast.push({
        tone: "info",
        title: "No calendars connected",
        description: "Connect one from the Add Bot dialog's Calendar tab first.",
      });
      return;
    }
    setSyncing(true);
    let failures = 0;
    for (const cal of calendars) {
      try {
        await mutateJson("POST", `/api/vexa/user/calendars/${encodeURIComponent(cal.id)}/sync`);
      } catch {
        failures += 1;
      }
    }
    await load();
    setSyncing(false);
    if (failures > 0) {
      toast.push({
        tone: "error",
        title: "Some calendars didn't sync",
        description: `${failures} of ${calendars.length} calendar${calendars.length === 1 ? "" : "s"} failed.`,
      });
    } else {
      toast.push({ tone: "success", title: "Calendars synced." });
    }
  }, [calendars, load, toast]);

  const toggleAutoJoin = useCallback(
    async (meeting: Meeting, next: boolean) => {
      setTogglingId(meeting.id);
      try {
        await mutateJson("PATCH", `/api/vexa/meetings/${encodeURIComponent(meeting.id)}`, { auto_join: next });
        await load();
        toast.push({
          tone: "success",
          title: next ? "Vexa will join this meeting." : "Vexa will not join this meeting.",
        });
      } catch (e) {
        toast.push({ tone: "error", title: "Couldn't update this meeting", description: presentError(e) });
      } finally {
        setTogglingId(null);
      }
    },
    [load, toast],
  );

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Header syncing={syncing} onSync={() => void syncNow()} />

      {state.kind === "loading" && <LoadingState label="Loading upcoming meetings…" />}

      {state.kind === "error" && <ErrorState message={state.message} onRetry={() => void load()} />}

      {state.kind === "loaded" && (
        <UpcomingList meetings={state.meetings} togglingId={togglingId} onToggle={toggleAutoJoin} />
      )}
    </div>
  );
}

function Header({ syncing, onSync }: { syncing: boolean; onSync: () => void }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">Upcoming</h1>
        <p className="text-sm text-ink-3">Meetings Vexa is watching for, grouped by day.</p>
      </div>
      <Button
        variant="secondary"
        onClick={onSync}
        loading={syncing}
        disabled={syncing}
        icon={<RefreshCw size={14} aria-hidden />}
      >
        Sync now
      </Button>
    </div>
  );
}

function UpcomingList({
  meetings,
  togglingId,
  onToggle,
}: {
  meetings: Meeting[];
  togglingId: string | null;
  onToggle: (meeting: Meeting, next: boolean) => void;
}) {
  const groups = groupUpcomingByDay(meetings);

  if (groups.length === 0) {
    return (
      <EmptyState
        title="No upcoming meetings"
        hint="Meetings from a connected calendar, or ones you schedule by hand, show up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.dayKey} aria-label={group.label}>
          <h2 className="mb-2 text-sm font-semibold text-ink-2">{group.label}</h2>
          <div className="flex flex-col gap-2">
            {group.meetings.map((m) => (
              <UpcomingRow
                key={m.id}
                meeting={m}
                busy={togglingId === m.id}
                onToggle={(next) => onToggle(m, next)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function UpcomingRow({
  meeting,
  busy,
  onToggle,
}: {
  meeting: Meeting;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const time = meeting.scheduledAt
    ? new Date(meeting.scheduledAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div
      role="group"
      aria-label={meeting.title}
      className="flex items-start justify-between gap-3 rounded-xl border border-line bg-card p-4"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{meeting.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          {time && <span>{time}</span>}
          <span>{meeting.platform}</span>
          {meeting.calendarName && (
            <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-ink-2">
              <CalendarIcon size={11} aria-hidden />
              {meeting.calendarName}
            </span>
          )}
        </p>
        {meeting.autoJoinError && (
          <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-warn">
            <AlertTriangle size={11} aria-hidden />
            {meeting.autoJoinError}
          </p>
        )}
      </div>
      <Toggle
        checked={meeting.autoJoin}
        onChange={onToggle}
        disabled={busy}
        label={meeting.autoJoin ? "Join" : "Don't join"}
      />
    </div>
  );
}
