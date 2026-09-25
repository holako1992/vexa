"use client";
/** The meetings list — the dashboard's home.
 *
 *  It polls `/api/vexa/meetings`. Polling rather than a websocket is a deliberate scope choice:
 *  the list needs to notice a meeting going live within seconds, and a 10s poll does that with no
 *  socket proxy in the server. The interval tightens to 5s while anything is live and relaxes to
 *  30s when nothing is, so an idle tab costs almost nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Search, Users, Video } from "lucide-react";
import { getJson, presentError } from "@/lib/api";
import { type Meeting, type MeetingRowDTO, filterMeetings, formatClock, sortMeetings, toMeeting } from "@/lib/meetings";
import { StatusPill } from "./StatusPill";
import { EmptyState, ErrorState, LoadingState } from "./EmptyState";
import { SendBotDialog } from "./SendBotDialog";
import { Button, Input, Tab, Tabs } from "./ui";

const TABS = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "past", label: "Past" },
  { id: "scheduled", label: "Upcoming" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const POLL_LIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;

/** A date a person reads: "Today · 14:05", "Yesterday · 09:12", else "12 Sep · 09:12". */
function whenLabel(m: Meeting): string {
  const iso = m.startTime || m.scheduledAt;
  if (!iso) return "No time recorded";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "No time recorded";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return `Today · ${time}`;
  if (sameDay(d, yesterday)) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${time}`;
}

export function MeetingsView() {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<TabId>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  // Kept in a ref so the poll effect does not restart on every refresh.
  const hasLive = useRef(false);

  const load = useCallback(async () => {
    try {
      const body = await getJson<{ meetings?: MeetingRowDTO[] }>("/api/vexa/meetings");
      const list = sortMeetings((body.meetings ?? []).map(toMeeting));
      hasLive.current = list.some((m) => m.phase === "live");
      setMeetings(list);
      setError(null);
    } catch (e) {
      // A failure replaces the list with an error, it never degrades to an empty list: "we could
      // not ask" and "you have none" are different answers and must look different.
      console.warn("meetings load failed", e);
      setError(presentError(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (cancelled) return;
      timer = setTimeout(tick, hasLive.current ? POLL_LIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const visible = useMemo(() => {
    if (!meetings) return [];
    const byTab = tab === "all" ? meetings : meetings.filter((m) => m.phase === tab);
    return filterMeetings(byTab, query);
  }, [meetings, tab, query]);

  const counts = useMemo(() => {
    const base = { all: meetings?.length ?? 0, live: 0, past: 0, scheduled: 0 };
    for (const m of meetings ?? []) base[m.phase] += 1;
    return base;
  }, [meetings]);

  return (
    <>
    {dialogOpen && (
      <SendBotDialog
        onClose={() => setDialogOpen(false)}
        onBotSent={() => { void load(); }}
      />
    )}
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
          <p className="mt-1 text-sm text-ink-2">Everything Vexa has captured for you.</p>
        </div>
        <Button variant="primary" size="lg" icon={<Bot size={15} aria-hidden />} onClick={() => setDialogOpen(true)} className="rounded-xl shadow-sm">
          Add Bot
        </Button>
      </header>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search meetings"
          aria-label="Search meetings"
          icon={<Search size={16} aria-hidden />}
          containerClassName="flex-1"
          className="bg-card py-2.5"
        />
        <Tabs value={tab} onChange={(v) => setTab(v as TabId)} label="Filter meetings">
          {TABS.map((t) => (
            <Tab key={t.id} value={t.id}>
              {t.label}
              <span className="ml-1.5 text-xs text-ink-3">{counts[t.id]}</span>
            </Tab>
          ))}
        </Tabs>
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && meetings === null && <LoadingState label="Loading meetings…" />}
      {!error && meetings !== null && visible.length === 0 && (
        <EmptyState
          title={query ? "No meetings match that search." : "No meetings yet."}
          hint={query ? undefined : "Send a Vexa bot to a meeting and it will show up here."}
        />
      )}

      {!error && visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((m) => (
            <li key={m.id}>
              <Link
                href={`/meetings/${encodeURIComponent(m.id)}`}
                className="block rounded-card border border-line bg-card px-4 py-4 transition-colors hover:border-line-strong"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <Video size={17} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-[15px] font-medium">{m.title}</h2>
                      <StatusPill phase={m.phase} status={m.status} />
                      {m.shared && (
                        <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-ink-2">Shared with you</span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                      <span>{whenLabel(m)}</span>
                      <span>{m.platform}</span>
                      {m.durationSeconds != null && <span>{formatClock(m.durationSeconds)}</span>}
                      {m.attendees.length > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Users size={12} aria-hidden />
                          {m.attendees.length}
                        </span>
                      )}
                      {m.hasRecording && <span>Recording</span>}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
    </>
  );
}
