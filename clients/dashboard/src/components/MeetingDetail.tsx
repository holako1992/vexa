"use client";
/** One meeting: its header facts and its transcript.
 *
 *  The transcript is fetched by ROW id (`/transcripts/by-id/<id>`), never by the native meeting
 *  code. The native code is not unique — it repeats across re-sends of the same link and across
 *  tenants — so keying the read by it would show one run's words under another run's heading.
 *
 *  Nothing on this page reshapes what the backend produced: segments render in the producer's
 *  order, with the producer's speaker attribution under any name the owner gave that speaker
 *  (`data.metadata.speaker_labels`). Search highlights, it does not filter out context; copy and
 *  every export emit exactly what is shown. The print stylesheet keeps the header, summary and
 *  transcript and drops the controls, which is what "PDF" in the Export dialog prints.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Copy, Search } from "lucide-react";
import {
  type Meeting,
  type MeetingRowDTO,
  type SegmentDTO,
  type TranscriptLine,
  activeSegmentIndex,
  distinctSpeakers,
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
import { Button, Input } from "./ui";
import { SummaryPanel } from "./SummaryPanel";
import { BotControls } from "./BotControls";
import { MeetingActions } from "./MeetingActions";
import { Participants } from "./Participants";
import { AudioPlayer, type AudioPlayerHandle } from "./AudioPlayer";
import { ExportMenu } from "./ExportMenu";
import { SpeakerNames } from "./SpeakerNames";
import { MeetingTags } from "./MeetingTags";
import type { ExportFact } from "@/lib/export";
import { applyLiveOps } from "@/lib/liveTranscript";
import { useLiveTranscript } from "./useLiveTranscript";
import { JumpToLive, LiveStatus, useFollowLive } from "./LiveFollow";

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [segments, setSegments] = useState<SegmentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const isLive = useRef(false);
  // While the meeting is live, streamed segments land on top of the REST transcript; the poll
  // below reads REST only while the stream is not delivering.
  const live = useLiveTranscript(meetingId, meeting?.phase === "live", () => void load());
  const lines = useMemo<TranscriptLine[] | null>(
    () => (segments === null ? null : toTranscript(applyLiveOps(segments, live.ops), meeting?.speakerLabels)),
    // `live.version` stands for `live.ops`, which is appended to in place.
    [segments, live.version, meeting?.speakerLabels], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const lineRefs = useRef<Array<HTMLLIElement | null>>([]);
  const playerRef = useRef<AudioPlayerHandle>(null);
  // The audio element's own playback position, read off `AudioPlayer`'s `onTimeUpdate` —
  // `null` until the player has fired at least once (nothing has played yet), which is exactly
  // what keeps `activeSegmentIndex` from highlighting segment zero before playback starts.
  const [currentTime, setCurrentTime] = useState<number | null>(null);

  // A link from a global-search result carries `?t=<seconds>` — the matched segment's
  // start offset. Scroll to, and highlight, the transcript line closest to it once the transcript
  // has loaded. `null` when the param is absent or not a finite number, so an ordinary visit to
  // the meeting page (no `t`) never highlights anything.
  const highlightAt = useMemo(() => {
    const raw = searchParams.get("t");
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }, [searchParams]);

  const highlightIndex = useMemo(() => {
    if (highlightAt == null || !lines || lines.length === 0) return null;
    let best = 0;
    let bestDiff = Infinity;
    lines.forEach((l, i) => {
      if (l.at == null) return;
      const diff = Math.abs(l.at - highlightAt);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    });
    return best;
  }, [lines, highlightAt]);

  useEffect(() => {
    if (highlightIndex == null) return;
    lineRefs.current[highlightIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightIndex]);

  // The segment playing right now, from the audio element's own position — takes over the
  // highlight from `highlightIndex` (the `?t=` search-result link) once playback actually starts,
  // since at that point "what's playing" is the more useful thing to show than where a link once
  // pointed. Never drives the scroll-into-view effect above: auto-scrolling the transcript on
  // every `timeupdate` while a recording plays would fight a person reading ahead or back.
  const playingIndex = useMemo(() => activeSegmentIndex(lines, currentTime), [lines, currentTime]);
  const activeIndex = playingIndex ?? highlightIndex;

  /** Clicking a transcript segment seeks the player to its own `start` and highlights it
   *  while playing (`activeIndex` above) — a no-op when this meeting has no recording. */
  function seekToLine(at: number | null) {
    if (at == null) return;
    playerRef.current?.seekTo(at);
  }

  /** Read the row, then its transcript. `rowOnly` skips the transcript while the row is still
   *  live — the stream is carrying it. */
  const load = useCallback(async (rowOnly = false) => {
    let row: MeetingRowDTO;
    try {
      row = await getJson<MeetingRowDTO>(`/api/vexa/meetings/${encodeURIComponent(meetingId)}`);
    } catch (e) {
      // A 404 is an answer: this row is not yours or does not exist. Anything else — a 5xx, a
      // network failure — is "we could not ask", which is a different answer and must not be
      // rendered as though the meeting were absent.
      if (e instanceof ApiError && e.status === 404) {
        setMeeting(null);
        setSegments([]);
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
    if (rowOnly && isLive.current) return;

    const mark = live.mark();
    try {
      const body = await getJson<{ segments?: SegmentDTO[] }>(
        `/api/vexa/transcripts/by-id/${encodeURIComponent(meetingId)}`,
      );
      setSegments(Array.isArray(body.segments) ? body.segments : []);
      live.rebase(mark);
    } catch (e) {
      console.warn("transcript load failed", e);
      setError(presentError(e));
    }
  }, [meetingId, live.mark, live.rebase]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      // While the stream is delivering, only the row is re-read (status, end of meeting).
      await load(isLive.current && live.modeRef.current === "streaming");
      if (cancelled) return;
      // A finished meeting's transcript does not change, so only a live one keeps polling.
      if (isLive.current) timer = setTimeout(tick, POLL_LIVE_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps -- `live.modeRef` is a ref, read at each tick

  const isLiveView = meeting?.phase === "live";
  const lastLine = lines && lines.length ? lines[lines.length - 1] : null;
  const follow = useFollowLive(
    isLiveView,
    `${lines?.length ?? 0}:${lastLine?.text.length ?? 0}`,
    highlightAt == null,
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !lines) return null;
    return new Set(lines.flatMap((l, i) => (l.text.toLowerCase().includes(q) || l.speaker.toLowerCase().includes(q) ? [i] : [])));
  }, [lines, query]);

  const plainText = useMemo(
    () => (meeting && lines ? transcriptToText(meeting.title, lines) : ""),
    [meeting, lines],
  );

  const speakers = useMemo(() => (lines ? distinctSpeakers(lines) : []), [lines]);

  /** The header facts as the exports carry them — the same values the page shows. */
  const exportFacts = useMemo<ExportFact[]>(() => {
    if (!meeting) return [];
    const facts: ExportFact[] = [{ label: "Platform", value: meeting.platform }];
    if (meeting.startTime) facts.push({ label: "Started", value: new Date(meeting.startTime).toLocaleString() });
    if (meeting.durationSeconds != null) facts.push({ label: "Duration", value: formatClock(meeting.durationSeconds) });
    if (meeting.tags.length) facts.push({ label: "Tags", value: meeting.tags.join(", ") });
    return facts;
  }, [meeting]);

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.warn("clipboard write failed", e);
    }
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
          <div className="print:hidden">
            <MeetingActions
              meeting={meeting}
              onRenamed={(title) => setMeeting((m) => (m ? { ...m, title } : m))}
              onDeleted={() => router.push("/")}
            />
          </div>
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
        <MeetingTags
          meetingId={meeting.id}
          tags={meeting.tags}
          editable={!meeting.shared}
          onChange={(tags) => setMeeting((m) => (m ? { ...m, tags } : m))}
        />
        <Participants meeting={meeting} />
      </header>

      <div className="print:hidden">
        <BotControls meeting={meeting} onStopped={() => void load()} />
      </div>

      {meeting.hasRecording && meeting.recordingId && (
        <div className="mb-6 rounded-card border border-line bg-card p-4 print:hidden">
          <AudioPlayer ref={playerRef} recordingId={meeting.recordingId} onTimeUpdate={setCurrentTime} />
        </div>
      )}

      <SummaryPanel meetingId={meetingId} meeting={meeting} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center print:hidden">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this transcript"
          aria-label="Search this transcript"
          icon={<Search size={16} aria-hidden />}
          containerClassName="flex-1"
          className="bg-card py-2.5"
        />
        <div className="flex flex-wrap gap-2">
          {!meeting.shared && (
            <SpeakerNames
              meetingId={meeting.id}
              speakers={speakers}
              labels={meeting.speakerLabels}
              onSaved={(speakerLabels) => setMeeting((m) => (m ? { ...m, speakerLabels } : m))}
            />
          )}
          <Button
            variant="secondary"
            onClick={copyTranscript}
            disabled={!lines?.length}
            icon={copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <ExportMenu title={meeting.title} facts={exportFacts} lines={lines ?? []} />
        </div>
      </div>

      {isLiveView && <LiveStatus mode={live.mode} />}
      {isLiveView && !follow.following && <JumpToLive onClick={follow.jumpToLive} />}

      {lines === null && <LoadingState label="Loading transcript…" />}
      {lines !== null && lines.length === 0 && (
        <EmptyState
          title={meeting.phase === "live" ? "Waiting for the first words…" : "No transcript for this meeting."}
          hint={meeting.phase === "live" ? "Lines appear as they are transcribed." : undefined}
        />
      )}
      {lines !== null && lines.length > 0 && (
        <ol aria-label="Transcript" className="space-y-4">
          {lines.map((line, i) => {
            const dim = matches !== null && !matches.has(i);
            const isHighlighted = i === activeIndex;
            // A segment is clickable to seek only when there is a player to seek AND this
            // segment carries its own offset — a segment `toTranscript` mapped to `at: null`
            // (the producer gave none) has nowhere meaningful to seek to.
            const seekable = !!(meeting.hasRecording && meeting.recordingId) && line.at != null;

            return (
              <li
                key={`${i}-${line.at ?? "x"}`}
                ref={(el) => {
                  lineRefs.current[i] = el;
                }}
                role={seekable ? "button" : undefined}
                tabIndex={seekable ? 0 : undefined}
                aria-label={seekable ? `Play from ${formatClock(line.at)}` : undefined}
                onClick={seekable ? () => seekToLine(line.at) : undefined}
                onKeyDown={
                  seekable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          seekToLine(line.at);
                        }
                      }
                    : undefined
                }
                className={
                  (dim ? "opacity-35 print:opacity-100 " : "") +
                  "transition-opacity " +
                  (seekable ? "cursor-pointer rounded-lg hover:bg-raised " : "") +
                  (isHighlighted ? "-mx-2 rounded-lg bg-accent-soft px-2 py-1 ring-2 ring-accent" : "")
                }
              >
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
    <Link href="/" className="mb-5 inline-flex print:hidden items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink">
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
