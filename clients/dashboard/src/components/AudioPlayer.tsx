"use client";
/** The meeting page's audio player. Two hops, exactly the flow
 *  `docs/docs/how-to/recordings.mdx` documents:
 *
 *   1. `GET /recordings/<id>/master?type=audio` — finalize-on-read: builds the master if it
 *      isn't one already, and answers `media_file_id` (not a shareable `raw_url` — this always
 *      composes the playback URL itself, through this dashboard's OWN allowlisted route, rather
 *      than trusting a server-embedded path verbatim).
 *   2. `<audio src="/api/vexa/recordings/<id>/media/<media_file_id>/raw?type=audio">` — the byte
 *      stream, Range-streamed end to end (`route.ts`'s `route.raw` branch forwards the browser's
 *      own `Range` header and passes back `206`/`Content-Range` untouched).
 *
 * `seekTo` is exposed via a ref (`MeetingDetail` calls it when a transcript segment is
 *  clicked) rather than taking a controlled `currentTime` prop — an `<audio>` element owns its
 *  own playback position; fighting that with a prop on every render would fight the browser's own
 *  seek/scrub gestures too.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getJson, presentError } from "@/lib/api";
import { ErrorState, LoadingState } from "./EmptyState";

export interface AudioPlayerHandle {
  /** Seek to this many seconds and resume playback — the click-a-segment-to-seek. A stopped
   *  player starts playing so the click's result is immediately audible, not just a moved
   *  scrubber. */
  seekTo(seconds: number): void;
}

interface MasterDTO {
  media_file_id: number | string | null;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, { recordingId: string; onTimeUpdate?: (seconds: number) => void }>(
  function AudioPlayer({ recordingId, onTimeUpdate }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [state, setState] = useState<"loading" | "error" | "ready">("loading");
    const [error, setError] = useState<string | null>(null);
    const [src, setSrc] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      setState("loading");
      setError(null);
      getJson<MasterDTO>(`/api/vexa/recordings/${encodeURIComponent(recordingId)}/master?type=audio`)
        .then((meta) => {
          if (cancelled) return;
          if (meta.media_file_id == null) {
            setState("error");
            setError("This meeting has no audio to play.");
            return;
          }
          setSrc(
            `/api/vexa/recordings/${encodeURIComponent(recordingId)}/media/` +
              `${encodeURIComponent(String(meta.media_file_id))}/raw?type=audio`,
          );
          setState("ready");
        })
        .catch((e) => {
          if (cancelled) return;
          setState("error");
          setError(presentError(e));
        });
      return () => {
        cancelled = true;
      };
    }, [recordingId]);

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        const el = audioRef.current;
        if (!el) return;
        el.currentTime = seconds;
        void el.play().catch(() => {
          // Autoplay can be refused before the person has interacted with the page at all; the
          // scrubber has still moved, which is the part it promises.
        });
      },
    }));

    if (state === "loading") return <LoadingState label="Loading recording…" />;
    if (state === "error") return <ErrorState message={error ?? "Couldn't load the recording."} />;

    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- a meeting recording has no track to caption.
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={src ?? undefined}
        aria-label="Meeting recording"
        className="w-full"
        onTimeUpdate={() => onTimeUpdate?.(audioRef.current?.currentTime ?? 0)}
      />
    );
  },
);
