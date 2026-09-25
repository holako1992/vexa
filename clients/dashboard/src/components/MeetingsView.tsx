"use client";
/** The meetings list — the dashboard's home.
 *
 *  It polls `/api/vexa/meetings`. Polling rather than a websocket is a deliberate scope choice:
 *  the list needs to notice a meeting going live within seconds, and a 10s poll does that with no
 *  socket proxy in the server. The interval tightens to 5s while anything is live and relaxes to
 *  30s when nothing is, so an idle tab costs almost nothing.
 *
 *  DB-48 — pagination: meeting-api's `GET /meetings` honours `limit`/`offset` and returns no total
 *  and no `has_more` (see `lib/meetings.ts`'s `pageMayContinue`). "Load more" fetches the next page
 *  and appends it; the poll instead re-fetches the FULL currently-loaded window on every tick
 *  (`offset=0, limit=<rows on screen>`), which is the rule that keeps a live row visible even when
 *  it was only loaded via "Load more" — see `mergeMeetingsPage`'s header comment for why a poll
 *  that only re-fetched page one would silently drop it. Tab counts are not shown as numbers
 *  because a count built from loaded rows is not a total — see the "N loaded" line below instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Search, Users, Video } from "lucide-react";
import { getJson, presentError } from "@/lib/api";
import {
  type Meeting,
  type MeetingRowDTO,
  filterMeetings,
  formatClock,
  mergeMeetingsPage,
  pageMayContinue,
  toMeeting,
} from "@/lib/meetings";
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
/** The page size "Load more" fetches, and the floor the poll's own re-fetch window never shrinks
 *  below (so the very first load — before anything is "loaded" yet — still asks for a full page). */
const PAGE_SIZE = 20;

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
  const router = useRouter();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<TabId>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Kept in refs so the poll effect does not restart on every refresh, and so a concurrent
  // "Load more" click and poll tick can see each other's in-flight state.
  const hasLive = useRef(false);
  const loadedCountRef = useRef(0);

  const load = useCallback(async () => {
    // The poll re-fetches the FULL loaded window (never just page one) — see the file header
    // comment for why that is the rule that keeps a live row on a later page visible.
    const isInitialLoad = loadedCountRef.current === 0;
    const limit = Math.max(loadedCountRef.current, PAGE_SIZE);
    try {
      const body = await getJson<{ meetings?: MeetingRowDTO[] }>(
        `/api/vexa/meetings?limit=${limit}&offset=0`,
      );
      const page = (body.meetings ?? []).map(toMeeting);
      setMeetings((prev) => mergeMeetingsPage(prev ?? [], page, "replace"));
      loadedCountRef.current = page.length;
      // `pageMayContinue` answers "does the NEXT page probably have rows" — true only for a fetch
      // that actually PROBES beyond what was already loaded (the very first load, at PAGE_SIZE;
      // "Load more", below). A later poll asks for exactly the window already on screen, not
      // anything beyond it, so a full return here proves only "the window still holds this many
      // rows", never "there is a row past the edge of it" — treating it as `pageMayContinue`
      // would (wrongly) flip "Load more" back on forever once the loaded count happens to equal
      // the true total. A SHORT return, though, is still informative either way: the window
      // shrank (a row left it — deleted, or moved out of scope), so there is definitely nothing
      // beyond it now.
      if (isInitialLoad) {
        setHasMore(pageMayContinue(page.length, limit));
      } else if (page.length < limit) {
        setHasMore(false);
      }
      hasLive.current = page.some((m) => m.phase === "live");
      setError(null);
    } catch (e) {
      // A failure replaces the list with an error, it never degrades to an empty list: "we could
      // not ask" and "you have none" are different answers and must look different.
      console.warn("meetings load failed", e);
      setError(presentError(e));
    }
  }, []);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const offset = loadedCountRef.current;
      const body = await getJson<{ meetings?: MeetingRowDTO[] }>(
        `/api/vexa/meetings?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      const page = (body.meetings ?? []).map(toMeeting);
      setMeetings((prev) => {
        const next = mergeMeetingsPage(prev ?? [], page, "append");
        loadedCountRef.current = next.length;
        return next;
      });
      setHasMore(pageMayContinue(page.length, PAGE_SIZE));
    } catch (e) {
      console.warn("load more failed", e);
      setError(presentError(e));
    } finally {
      setLoadingMore(false);
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

  /** Reconciling the two searches (DB-44 vs. this box): this input only ever filters the rows
   *  already loaded into the browser — it cannot see a match sitting on a page nobody has loaded,
   *  or a match inside a transcript's words rather than a title/attendee. Enter hands the same
   *  text to `/search`, which asks the server (DB-44's `GET /transcripts/search`) across every
   *  meeting and every transcript, not just what is on screen. */
  function onQueryKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const q = query.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

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

      <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKeyDown}
          placeholder="Filter loaded meetings"
          aria-label="Filter loaded meetings"
          hint="Press Enter to search everything, including transcripts"
          icon={<Search size={16} aria-hidden />}
          containerClassName="flex-1"
          className="bg-card py-2.5"
        />
        <Tabs value={tab} onChange={(v) => setTab(v as TabId)} label="Filter meetings">
          {TABS.map((t) => (
            <Tab key={t.id} value={t.id}>
              {t.label}
            </Tab>
          ))}
        </Tabs>
      </div>

      {/* DB-48: no per-tab numbers here — meeting-api's GET /meetings never reports a total, so a
          count built from loaded rows would only ever describe what happens to be on screen, not
          "how many live meetings you have". One honest line instead of four dishonest ones. */}
      {meetings !== null && (
        <p className="mb-4 text-xs text-ink-3">
          {meetings.length} loaded{hasMore ? " · more available" : ""}
        </p>
      )}

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

      {/* Keyboard-accessible by construction: a real <button>, no scroll-triggered auto-load.
          Fetches the next page and appends it — see mergeMeetingsPage's "append" mode. Shown
          regardless of the active tab or the loaded-only filter above: more rows widen the pool
          every tab and the filter draw from, even if the tab you're on doesn't show a new row
          from this particular page. */}
      {!error && hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
    </>
  );
}
