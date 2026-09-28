/** The shapes and pure mapping for `/recordings` (DB-50/DB-52) — the same rule `meetings.ts`
 *  follows: a reader must not re-derive a producer's data, only pick a display shape out of what
 *  the backend already decided. `RecordingRowDTO` is meeting-api's own LIST projection
 *  (`meeting_api/recordings/router.py`'s `LIST_RECORDING_KEYS`/`LIST_MEDIA_FILE_KEYS`) — narrower
 *  than the full recording record `GET /recordings/<id>` would return, which this dashboard never
 *  reads (see `upstream.ts`'s comment on why that route isn't in the allowlist).
 */

export interface RecordingMediaFileDTO {
  id: number | string;
  type?: string | null;
  format?: string | null;
  duration_seconds?: number | null;
  file_size_bytes?: number | null;
}

export interface RecordingRowDTO {
  id: number | string;
  meeting_id: number | string;
  status?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  playback_url?: string | null;
  /** Set by the retention sweep (DB-78) when this recording is queued for purge under the
   *  account's plan — never a promise of WHEN, just that it is scheduled. */
  deletion_pending?: boolean;
  media_files?: RecordingMediaFileDTO[];
  /** Lifted to the top level by the producer as the longest of this recording's media files
   *  (`_project_list_recording`) — never re-derived here from `media_files` a second time. */
  duration_seconds?: number | null;
}

export interface RecordingsPageDTO {
  recordings?: RecordingRowDTO[];
  total?: number;
  limit?: number;
  offset?: number;
  has_more?: boolean;
}

export interface Recording {
  id: string;
  meetingId: string;
  /** The producer's own status word (`"in_progress"` | `"completed"`), shown verbatim — never
   *  reworded, same rule `Meeting.status` follows. */
  status: string;
  createdAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  deletionPending: boolean;
  /** This recording's AUDIO media file id, for the player (`GET /recordings/<id>/master`) and the
   *  download link (`.../media/<mediaFileId>/download`) to address — `null` when this recording
   *  has no audio track yet (still uploading, or a video-only capture), in which case the row
   *  offers no player/download control rather than one pointed at nothing. */
  audioMediaFileId: string | null;
}

/** Map one `GET /recordings` list row. Nothing here reshapes what the producer decided — picking
 *  the audio media file out of `media_files[]` is the one piece of real work, and even that is
 *  just finding the row the player/download controls need, not deriving anything new. */
export function toRecording(d: RecordingRowDTO): Recording {
  const media = Array.isArray(d.media_files) ? d.media_files : [];
  const audio = media.find((m) => m && m.type === "audio");
  return {
    id: String(d.id),
    meetingId: String(d.meeting_id),
    status: d.status || "unknown",
    createdAt: d.created_at ?? null,
    completedAt: d.completed_at ?? null,
    durationSeconds: typeof d.duration_seconds === "number" && Number.isFinite(d.duration_seconds)
      ? d.duration_seconds
      : null,
    deletionPending: !!d.deletion_pending,
    audioMediaFileId: audio && audio.id != null ? String(audio.id) : null,
  };
}

/** "12 Sep 2026, 14:05", or "Unknown date" for a missing/unparseable timestamp — never a raw ISO
 *  string or an "Invalid Date". */
export function formatRecordedAt(iso: string | null): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "Unknown date";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "Kept for 7 days" / "Kept for 1 year" / "Kept indefinitely" — `null` on the entitlements
 *  resolver's `recording_retention_days` means unlimited (same "null means unlimited" rule every
 *  other limit in `entitlements.ts` follows), never a large number to compare against. Renders
 *  365 as "1 year" and 30-ish values as months purely for readability — the catalog
 *  (`docs/docs/governance` / `TASKS.md`'s plan table) only ever uses whole days, months or a year,
 *  so this never needs to handle an odd day count gracefully beyond falling back to "N days". */
export function formatRetention(days: number | null): string {
  if (days == null) return "Kept indefinitely";
  if (days === 365) return "Kept for 1 year";
  if (days % 30 === 0 && days >= 30) return `Kept for ${days / 30} month${days === 30 ? "" : "s"}`;
  return `Kept for ${days} day${days === 1 ? "" : "s"}`;
}
