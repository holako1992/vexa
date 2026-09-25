/** The shapes the dashboard renders, and the mapping from meeting-api's rows onto them.
 *
 *  A reader must not re-derive a producer's data: nothing here reshapes a transcript (no
 *  clustering, no speaker inference, no summarisation). The mapping is presentation only —
 *  picking a title, bucketing a status, formatting a time — and every field it reads is one the
 *  backend already decided.
 */

/** A row as meeting-api returns it from GET /meetings (live AND past). */
export interface MeetingRowDTO {
  id: number | string;
  platform: string;
  native_meeting_id: string | null;
  status: string;
  shared?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  constructed_meeting_url?: string | null;
  data?: {
    title?: string;
    recordings?: unknown[];
    scheduled_at?: string;
    stop_requested?: boolean;
    attendees?: { email: string; name?: string }[];
    /** The producer's own join-failure detail (lifecycle/join_evidence.py), verbatim — never
     *  reworded here. Present only when a join attempt actually failed. */
    reason?: string | null;
  } | null;
}

/** A transcript segment from GET /transcripts/... */
export interface SegmentDTO {
  start?: number | null;
  speaker?: string | null;
  text?: string | null;
}

/** Coarse bucket the list groups and filters by. */
export type MeetingPhase = "live" | "scheduled" | "past";

export interface Meeting {
  id: string;
  title: string;
  /** The human label (e.g. "Google Meet") — for display only. */
  platform: string;
  /** The raw platform slug (e.g. "google_meet") — for building a `/bots/<platform>/<native>` or
   *  `/meetings/<platform>/<native>/...` upstream path. Never shown to a reader. */
  platformId: string;
  /** The raw meeting-api status — shown verbatim on the detail page, never invented. */
  status: string;
  phase: MeetingPhase;
  startTime: string | null;
  endTime: string | null;
  scheduledAt: string | null;
  /** Seconds, when both ends are known. null while a meeting is running or a time is missing. */
  durationSeconds: number | null;
  attendees: { email: string; name?: string }[];
  hasRecording: boolean;
  shared: boolean;
  nativeId: string | null;
  meetingUrl: string | null;
  /** The producer's own join-failure reason, verbatim — null when the bot never failed to join. */
  joinFailureReason: string | null;
}

/** Statuses where the bot is in, or heading to, the room. */
const LIVE_STATUSES = new Set(["active", "joining", "requested", "awaiting_admission", "needs_help", "stopping"]);
const SCHEDULED_STATUSES = new Set(["scheduled", "idle"]);

const PLATFORM_LABELS: Record<string, string> = {
  google_meet: "Google Meet",
  teams: "Microsoft Teams",
  zoom: "Zoom",
  jitsi: "Jitsi",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** `stopped` is not a DB enum value — it is a `completed` row the user stopped. */
function displayStatus(d: MeetingRowDTO): string {
  return d.status === "completed" && d.data?.stop_requested ? "stopped" : d.status;
}

function phaseOf(d: MeetingRowDTO): MeetingPhase {
  if (LIVE_STATUSES.has(d.status)) return "live";
  if (SCHEDULED_STATUSES.has(d.status) && !d.start_time) return "scheduled";
  return "past";
}

function durationOf(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

/** Map one row. The title falls back honestly: a user-given title wins, then platform · code,
 *  and a link-less plan is "Untitled meeting" rather than a fabricated label. */
export function toMeeting(d: MeetingRowDTO): Meeting {
  const native = d.native_meeting_id;
  const startTime = d.start_time ?? null;
  const endTime = d.end_time ?? null;
  return {
    id: String(d.id),
    title: d.data?.title || (native ? `${platformLabel(d.platform)} · ${native}` : "Untitled meeting"),
    platform: platformLabel(d.platform),
    platformId: d.platform,
    status: displayStatus(d),
    phase: phaseOf(d),
    startTime,
    endTime,
    scheduledAt: d.data?.scheduled_at ?? null,
    durationSeconds: durationOf(startTime, endTime),
    attendees: d.data?.attendees ?? [],
    hasRecording: !!d.data?.recordings?.length,
    shared: !!d.shared,
    nativeId: native,
    meetingUrl: d.constructed_meeting_url ?? null,
    joinFailureReason: d.data?.reason ?? null,
  };
}

/** Newest first: live meetings lead, then by the most meaningful timestamp each row carries. */
export function sortMeetings(list: Meeting[]): Meeting[] {
  const when = (m: Meeting) => Date.parse(m.startTime || m.scheduledAt || "") || 0;
  return [...list].sort((a, b) => {
    if (a.phase === "live" && b.phase !== "live") return -1;
    if (b.phase === "live" && a.phase !== "live") return 1;
    return when(b) - when(a);
  });
}

/** Free-text filter over the fields a person can actually see on a card. */
export function filterMeetings(list: Meeting[], query: string): Meeting[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) =>
    [m.title, m.platform, m.status, m.nativeId ?? "", ...m.attendees.map((a) => a.name || a.email)]
      .some((f) => f.toLowerCase().includes(q)),
  );
}

export interface TranscriptLine {
  /** Seconds from the start of the recording, when the producer gave one. */
  at: number | null;
  speaker: string;
  text: string;
}

/** Map the segments of a transcript response. Empty/blank segments are dropped; nothing is
 *  merged, re-ordered or re-attributed — the producer's order is the order shown. */
export function toTranscript(segments: readonly SegmentDTO[] | undefined | null): TranscriptLine[] {
  if (!Array.isArray(segments)) return [];
  return segments
    .map((s) => ({
      at: typeof s.start === "number" && Number.isFinite(s.start) ? s.start : null,
      speaker: (s.speaker || "").trim() || "Unknown speaker",
      text: (s.text || "").trim(),
    }))
    .filter((l) => l.text.length > 0);
}

/** mm:ss, or h:mm:ss past an hour. Used for both a transcript offset and a duration. */
export function formatClock(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The transcript as plain text, for copy + download. One line per segment, speaker-prefixed. */
export function transcriptToText(title: string, lines: readonly TranscriptLine[]): string {
  const body = lines
    .map((l) => `${l.at != null ? `[${formatClock(l.at)}] ` : ""}${l.speaker}: ${l.text}`)
    .join("\n");
  return `${title}\n${"=".repeat(title.length)}\n\n${body}\n`;
}

/** A stable colour index per speaker, so one person keeps one colour down the page. */
export function speakerIndex(speaker: string, palette: number): number {
  let h = 0;
  for (let i = 0; i < speaker.length; i++) h = (h * 31 + speaker.charCodeAt(i)) >>> 0;
  return h % palette;
}

/** Initials for an avatar chip — at most two letters, from the first and last word. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + last).toUpperCase();
}
