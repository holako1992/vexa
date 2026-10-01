"use client";
/** The meeting page's live transcript subscription: the streamed events since the last REST read,
 *  and which mode the feed is in.
 *
 *  The REST transcript stays the page's base — the first load, the backfill after a drop, and the
 *  only source while the stream is unavailable. Streamed events are kept as an ordered list on top
 *  of it (`ops`, folded by `lib/liveTranscript.ts`'s `applyLiveOps`), and a REST read prunes the
 *  ones it already reflects: call `mark()` before issuing the read and `rebase(mark)` when it
 *  lands. */
import { useCallback, useEffect, useRef, useState } from "react";
import { pruneLiveOps, type LiveOp } from "@/lib/liveTranscript";
import { startLiveStream, type LiveMode } from "@/lib/liveStream";

export type LiveTranscriptMode = LiveMode | "off";

export interface LiveTranscript {
  mode: LiveTranscriptMode;
  /** The mode as of now, for timers that must not wait for a re-render. */
  modeRef: React.RefObject<LiveTranscriptMode>;
  ops: readonly LiveOp[];
  /** Bumps on every change to `ops`. */
  version: number;
  mark(): number;
  rebase(mark: number): void;
}

export function useLiveTranscript(meetingId: string, active: boolean, onEnded: () => void): LiveTranscript {
  const [mode, setMode] = useState<LiveTranscriptMode>("off");
  const [version, setVersion] = useState(0);
  const modeRef = useRef<LiveTranscriptMode>("off");
  const opsRef = useRef<LiveOp[]>([]);
  const seqRef = useRef(0);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    const setBoth = (m: LiveTranscriptMode) => {
      modeRef.current = m;
      setMode(m);
    };
    if (!active) {
      setBoth("off");
      return;
    }
    const stop = startLiveStream(`/api/vexa/meetings/${encodeURIComponent(meetingId)}/stream`, {
      onEvent(event) {
        seqRef.current += 1;
        opsRef.current.push({ seq: seqRef.current, event });
        setVersion((v) => v + 1);
      },
      onMode: setBoth,
      onEnded() {
        setBoth("off");
        onEndedRef.current();
      },
    });
    return () => {
      stop();
      setBoth("off");
    };
  }, [meetingId, active]);

  const mark = useCallback(() => seqRef.current, []);
  const rebase = useCallback((at: number) => {
    const kept = pruneLiveOps(opsRef.current, at);
    if (kept.length === opsRef.current.length) return;
    opsRef.current = kept;
    setVersion((v) => v + 1);
  }, []);

  return { mode, modeRef, ops: opsRef.current, version, mark, rebase };
}
