"use client";
/** One meeting: its header facts and its transcript.
 *
 *  The transcript is fetched by ROW id (`/transcripts/by-id/<id>`), never by the native meeting
 *  code. The native code is not unique — it repeats across re-sends of the same link and across
 *  tenants — so keying the read by it would show one run's words under another run's heading.
 *
 *  Nothing on this page reshapes what the backend produced: segments render in the producer's
 *  order, with the producer's speaker attribution. Search highlights, it does not filter out
 *  context; copy and download emit exactly what is shown.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Download, Search } from "lucide-react";
import {
  type Meeting,
  type MeetingRowDTO,
  type SegmentDTO,
  type TranscriptLine,
  formatClock,
  initialsOf,
  speakerIndex,
  toMeeting,
  toTranscript,
  transcriptToText,
} from "@/lib/meetings";
import { ApiError, getJson, presentError } from "@/lib/api";
import { StatusPill } from "./StatusPill";
import { EmptyState, ErrorState, LoadingState } from "./EmptyState";

/** Avatar hues, in the same family as the accent so a busy transcript still reads calm.
 *
 *  One hue per speaker, and the chip's fill is that hue mixed into TRANSPARENT rather than a frozen
 *  pastel — so it lands on whatever the theme's card colour is and reads correctly in both. A fixed
 *  light pastel would be a bright dot on a dark page. */
const SPEAKER_HUES = ["#2f6df6", "#17916a", "#b7791f", "#7c4dcc", "#d6484d", "#12788c"];

function speakerChipStyle(speaker: string): React.CSSProperties {
  const hue = SPEAKER_HUES[speakerIndex(speaker, SPEAKER_HUES.length)]!;
  return { backgroundColor: `color-mix(in srgb, ${hue} 18%, transparent)`, color: hue };
}

const POLL_LIVE_MS = 5_000;

export function MeetingDetail({ meetingId }: { meetingId: string }) {
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [lines, setLines] = useState<TranscriptLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const isLive = useRef(false);

  const load = useCallback(async () => {
    let row: MeetingRowDTO;
    try {
      row = await getJson<MeetingRowDTO>(`/api/vexa/meetings/${encodeURIComponent(meetingId)}`);
    } catch (e) {
      // A 404 is an answer: this row is not yours or does not exist. Anything else — a 5xx, a
      // network failure — is "we could not ask", which is a different answer and must not be
      // rendered as though the meeting were absent.
      if (e instanceof ApiError && e.status === 404) {
        setMeeting(null);
        setLines([]);
        setError(null);
        isLive.current = false;
        return;
      }
      console.warn("meeting load failed", e);
      setError(presentError(e));
      return;
    }

    const mapped = toMeeting(row);
    setMeeting(mapped);
    setError(null);
    isLive.current = mapped.phase === "live";

    try {
      const body = await getJson<{ segments?: SegmentDTO[] }>(
        `/api/vexa/transcripts/by-id/${encodeURIComponent(meetingId)}`,
      );
      setLines(toTranscript(body.segments));
    } catch (e) {
      console.warn("transcript load failed", e);
      setError(presentError(e));
    }
  }, [meetingId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (cancelled) return;
      // A finished meeting's transcript does not change, so only a live one keeps polling.
      if (isLive.current) timer = setTimeout(tick, POLL_LIVE_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !lines) return null;
    return new Set(lines.flatMap((l, i) => (l.text.toLowerCase().includes(q) || l.speaker.toLowerCase().includes(q) ? [i] : [])));
  }, [lines, query]);

  const plainText = useMemo(
    () => (meeting && lines ? transcriptToText(meeting.title, lines) : ""),
    [meeting, lines],
  );

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.warn("clipboard write failed", e);
    }
  }

  function downloadTranscript() {
    const blob = new Blob([plainText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(meeting?.title || "transcript").replace(/[^\w.-]+/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <BackLink />
        <ErrorState message={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (meeting === undefined) return <LoadingState label="Loading meeting…" />;
  if (meeting === null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <BackLink />
        <EmptyState title="That meeting isn't in your list." hint="It may belong to another account, or have been removed." />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8 md:py-10">
      <BackLink />

      <header className="mb-6 border-b border-line pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{meeting.title}</h1>
          <StatusPill phase={meeting.phase} status={meeting.status} />
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
          <Fact label="Platform" value={meeting.platform} />
          {meeting.startTime && <Fact label="Started" value={new Date(meeting.startTime).toLocaleString()} />}
          {meeting.durationSeconds != null && <Fact label="Duration" value={formatClock(meeting.durationSeconds)} />}
          {meeting.scheduledAt && !meeting.startTime && (
            <Fact label="Scheduled" value={new Date(meeting.scheduledAt).toLocaleString()} />
          )}
        </dl>
        {meeting.attendees.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {meeting.attendees.map((a) => (
              <span key={a.email} className="rounded-full bg-raised px-2.5 py-1 text-xs text-ink-2">
                {a.name || a.email}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this transcript"
            aria-label="Search this transcript"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-sm placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copyTranscript}
            disabled={!lines?.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-2 hover:bg-raised disabled:opacity-40"
          >
            {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={downloadTranscript}
            disabled={!lines?.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-2 hover:bg-raised disabled:opacity-40"
          >
            <Download size={15} aria-hidden />
            Download
          </button>
        </div>
      </div>

      {lines === null && <LoadingState label="Loading transcript…" />}
      {lines !== null && lines.length === 0 && (
        <EmptyState
          title={meeting.phase === "live" ? "Waiting for the first words…" : "No transcript for this meeting."}
          hint={meeting.phase === "live" ? "Lines appear as they are transcribed." : undefined}
        />
      )}
      {lines !== null && lines.length > 0 && (
        <ol className="space-y-4">
          {lines.map((line, i) => {
            const dim = matches !== null && !matches.has(i);

            return (
              <li key={`${i}-${line.at ?? "x"}`} className={dim ? "opacity-35 transition-opacity" : "transition-opacity"}>
                <div className="flex gap-3">
                  <span
                    style={speakerChipStyle(line.speaker)}
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  >
                    {initialsOf(line.speaker)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{line.speaker}</span>
                      {line.at != null && <span className="text-xs tabular-nums text-ink-3">{formatClock(line.at)}</span>}
                    </div>
                    <p className="mt-0.5 text-[15px] leading-relaxed text-ink-2">{line.text}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink">
      <ArrowLeft size={15} aria-hidden />
      All meetings
    </Link>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-3">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
