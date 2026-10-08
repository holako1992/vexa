"use client";
/** The meetings list — the dashboard's home.
 *
 *  It polls `/api/vexa/meetings`. Polling rather than a websocket is a deliberate scope choice:
 *  the list needs to notice a meeting going live within seconds, and a 10s poll does that with no
 *  socket proxy in the server. The interval tightens to 5s while anything is live and relaxes to
 *  30s when nothing is, so an idle tab costs almost nothing.
 *
 * Pagination: meeting-api's `GET /meetings` honours `limit`/`offset` and reports the
 *  store's own `has_more` on the response envelope. "Load more" fetches the next page and appends
 *  it, reading `has_more` straight off that response; the poll instead re-fetches the FULL
 *  currently-loaded window on every tick (`offset=0, limit=<rows on screen>`), which is the rule
 *  that keeps a live row visible even when it was only loaded via "Load more" — see
 *  `mergeMeetingsPage`'s header comment for why a poll that only re-fetched page one would
 *  silently drop it. Tab counts are not shown as numbers because a count built from loaded rows is
 *  not a total — see the loaded-count line below instead.
 *
 *  Tags: `?tag=<tag>` narrows the list on the SERVER — every request carries meeting-api's
 *  `metadata={"tags":["<tag>"]}` containment filter, so paging and polling both walk only the
 *  tagged meetings, never a filtered view of whatever page happened to load. The tag chips above
 *  the list are the tags on the loaded rows; each links to that filter. Sorting reorders the
 *  loaded rows only, with live meetings kept on top.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, Search, Tag, Users, Video, X } from "lucide-react";
import { getJson, presentError } from "@/lib/api";
import { normalizeTag, tagFilterValue } from "@/lib/annotations";
import {
  MEETING_SORTS,
  type Meeting,
  type MeetingSort,
  type MeetingsPageDTO,
  filterMeetings,
  formatClock,
  loadedTags,
  mergeMeetingsPage,
  sortMeetingsBy,
  toMeeting,
} from "@/lib/meetings";
import { tagHref } from "./MeetingTags";
import { StatusPill } from "./StatusPill";
import { EmptyState, ErrorState, LoadingState } from "./EmptyState";
import { SendBotDialog } from "./SendBotDialog";
import { FirstRunWizard, type CalendarReturn } from "./FirstRunWizard";
import { useFirstRun } from "./useFirstRun";
import { Button, Input, Tab, Tabs, useToast } from "./ui";

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
  const searchParams = useSearchParams();
  const toast = useToast();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<TabId>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitialTab, setDialogInitialTab] = useState<"link" | "calendar">("link");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sortBy, setSortBy] = useState<MeetingSort>("newest");
  // The first-run welcome. Once it has opened it stays mounted until it is closed — it ends the
  // welcome itself (sending the first bot does), and the "your bot is joining" panel must outlive
  // that — so the decision to open is latched rather than re-derived on every render.
  const firstRun = useFirstRun();
  const [wizardLatched, setWizardLatched] = useState(false);
  const [wizardClosed, setWizardClosed] = useState(false);
  const [calendarReturn, setCalendarReturn] = useState<CalendarReturn>(null);
  useEffect(() => { if (firstRun.visible) setWizardLatched(true); }, [firstRun.visible]);
  const tag = normalizeTag(searchParams.get("tag") ?? "");
  const tagQuery = tag ? `&metadata=${encodeURIComponent(tagFilterValue(tag))}` : "";
  // Kept in refs so the poll effect does not restart on every refresh, and so a concurrent
  // "Load more" click and poll tick can see each other's in-flight state.
  const hasLive = useRef(false);
  const loadedCountRef = useRef(0);
  // The filter the list on screen belongs to. A response that comes back after the tag changed
  // answers a question nobody is asking any more and is dropped, never merged into the new list.
  const activeTagQuery = useRef(tagQuery);

  const load = useCallback(async () => {
    // The poll re-fetches the FULL loaded window (never just page one) — see the file header
    // comment for why that is the rule that keeps a live row on a later page visible.
    const limit = Math.max(loadedCountRef.current, PAGE_SIZE);
    try {
      const body = await getJson<MeetingsPageDTO>(`/api/vexa/meetings?limit=${limit}&offset=0${tagQuery}`);
      if (activeTagQuery.current !== tagQuery) return;
      const page = (body.meetings ?? []).map(toMeeting);
      setMeetings((prev) => mergeMeetingsPage(prev ?? [], page, "replace"));
      loadedCountRef.current = page.length;
      // `has_more` is meeting-api's own word for "does a row exist past this window" — read
      // verbatim off every response, poll included: the store answers against the real total, not
      // against how many rows this particular request happened to return.
      setHasMore(body.has_more ?? false);
      hasLive.current = page.some((m) => m.phase === "live");
      setError(null);
    } catch (e) {
      // A failure replaces the list with an error, it never degrades to an empty list: "we could
      // not ask" and "you have none" are different answers and must look different.
      console.warn("meetings load failed", e);
      setError(presentError(e));
    }
  }, [tagQuery]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const offset = loadedCountRef.current;
      const body = await getJson<MeetingsPageDTO>(
        `/api/vexa/meetings?limit=${PAGE_SIZE}&offset=${offset}${tagQuery}`,
      );
      if (activeTagQuery.current !== tagQuery) return;
      const page = (body.meetings ?? []).map(toMeeting);
      setMeetings((prev) => {
        const next = mergeMeetingsPage(prev ?? [], page, "append");
        loadedCountRef.current = next.length;
        return next;
      });
      setHasMore(body.has_more ?? false);
    } catch (e) {
      console.warn("load more failed", e);
      setError(presentError(e));
    } finally {
      setLoadingMore(false);
    }
  }, [tagQuery]);

  useEffect(() => {
    // A different tag is a different list: start it from its own first page.
    activeTagQuery.current = tagQuery;
    setMeetings(null);
    setHasMore(false);
    loadedCountRef.current = 0;
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

  // EITHER provider's OAuth callback page (`/calendar/google/callback`,
  // `/calendar/microsoft/callback`) sends the browser back here with `?calendar=connected
  // &provider=<google|microsoft>` (success) or `?calendar=1` (the person clicked "Back to
  // Calendar" after an error, or wants another attempt — no `provider`, since an error already
  // showed its own message on the callback page and never toasts again here). Where it lands
  // depends on whether the person is mid-welcome: the welcome picks up where it left off, and
  // anyone else lands back on the Calendar tab of the SAME dialog they started the OAuth flow
  // from, rather than the meetings list. So this waits for the welcome's state before deciding.
  // The params are stripped immediately after so a refresh doesn't reopen the dialog or
  // re-toast. `handledCalendarReturn` guards against React's dev-mode double-invoked effect
  // firing this twice (and so double-toasting) for the SAME landing — `router.replace` below is
  // what actually makes it not fire again on a later render.
  const handledCalendarReturn = useRef(false);
  useEffect(() => {
    const calendarParam = searchParams.get("calendar");
    if (!calendarParam || handledCalendarReturn.current || !firstRun.ready) return;
    handledCalendarReturn.current = true;
    const provider = searchParams.get("provider") === "microsoft" ? "microsoft" : "google";
    if (firstRun.visible) {
      setCalendarReturn(calendarParam === "connected" ? { kind: "connected", provider } : { kind: "retry" });
    } else {
      setDialogInitialTab("calendar");
      setDialogOpen(true);
      if (calendarParam === "connected") {
        const label = provider === "microsoft" ? "Microsoft 365" : "Google Calendar";
        toast.push({ tone: "success", title: `${label} connected.` });
      }
    }
    router.replace("/", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, firstRun.ready, firstRun.visible]);

  const visible = useMemo(() => {
    if (!meetings) return [];
    const byTab = tab === "all" ? meetings : meetings.filter((m) => m.phase === tab);
    return sortMeetingsBy(filterMeetings(byTab, query), sortBy);
  }, [meetings, tab, query, sortBy]);

  const tagsOnScreen = useMemo(() => loadedTags(meetings ?? []), [meetings]);

  /** Reconciling the two searches (vs. this box): this input only ever filters the rows
   *  already loaded into the browser — it cannot see a match sitting on a page nobody has loaded,
   *  or a match inside a transcript's words rather than a title/attendee. Enter hands the same
   * text to `/search`, which asks the server (the `GET /transcripts/search`) across every
   *  meeting and every transcript, not just what is on screen. */
  function onQueryKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const q = query.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <>
    {wizardLatched && !wizardClosed && firstRun.status && (
      <FirstRunWizard
        initialStep={firstRun.status.step}
        calendarReturn={calendarReturn}
        onBotSent={() => { void load(); }}
        onEnded={(state) => {
          firstRun.update({ state, step: firstRun.status!.step });
          // Skipping leaves at once; finishing by sending a bot stays for its "joining" panel.
          if (state === "skipped") setWizardClosed(true);
        }}
        onClose={() => setWizardClosed(true)}
      />
    )}
    {dialogOpen && (
      <SendBotDialog
        onClose={() => { setDialogOpen(false); setDialogInitialTab("link"); }}
        onBotSent={() => { void load(); }}
        initialTab={dialogInitialTab}
      />
    )}
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
          <p className="mt-1 text-sm text-ink-2">Everything Vexa has captured for you.</p>
        </div>
        <Button variant="primary" size="lg" icon={<Bot size={15} aria-hidden />} onClick={() => { setDialogInitialTab("link"); setDialogOpen(true); }} className="rounded-xl shadow-sm">
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
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <span className="sr-only sm:not-sr-only">Sort</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as MeetingSort)}
            aria-label="Sort meetings"
            className="h-10 rounded-lg border border-line bg-card px-2.5 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {MEETING_SORTS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(tag || tagsOnScreen.length > 0) && (
        <div role="group" aria-label="Filter by tag" className="mb-3 flex flex-wrap items-center gap-1.5">
          <Tag size={13} aria-hidden className="text-ink-3" />
          {tag ? (
            <>
              <span className="text-xs text-ink-2">Tagged</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-accent py-0.5 pl-2.5 pr-1 text-xs font-medium text-accent-ink">
                {tag}
                <Link href="/" aria-label={`Clear tag filter ${tag}`} className="rounded-full p-0.5 hover:bg-black/15">
                  <X size={12} aria-hidden />
                </Link>
              </span>
            </>
          ) : (
            tagsOnScreen.map((t) => (
              <Link
                key={t}
                href={tagHref(t)}
                className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent hover:underline"
              >
                {t}
              </Link>
            ))
          )}
        </div>
      )}

      {/* No per-tab numbers here — meeting-api's GET /meetings never reports a total, so a
          count built from loaded rows would only ever describe what happens to be on screen, not
          "how many live meetings you have". `has_more` (the store's own word) says whether the
          list is honestly complete, so this line always tells the truth about the loaded window. */}
      {meetings !== null && (
        <p className="mb-4 text-xs text-ink-3">
          {meetings.length} loaded
          {meetings.length > 0 && (hasMore ? " · more available" : " · all meetings loaded")}
        </p>
      )}

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && meetings === null && <LoadingState label="Loading meetings…" />}
      {!error && meetings !== null && visible.length === 0 && (
        <EmptyState
          title={query ? "No meetings match that search." : tag ? `No meetings tagged “${tag}”.` : "No meetings yet."}
          hint={query || tag ? undefined : "Send a Vexa bot to a meeting and it will show up here."}
        />
      )}
      {!error && meetings !== null && meetings.length === 0 && wizardClosed && firstRun.visible && (
        <div className="flex justify-center pb-10">
          <Button variant="primary" onClick={() => setWizardClosed(false)}>
            Finish setup
          </Button>
        </div>
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
                      {m.tags.map((t) => (
                        <span key={t} className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">
                          {t}
                        </span>
                      ))}
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
