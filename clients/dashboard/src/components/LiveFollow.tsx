"use client";
/** Following a live transcript: the page keeps the newest line in view while the reader is at the
 *  bottom, stops the moment they scroll up, and offers a "Jump to live" button to come back.
 *
 *  "At the bottom" is measured on every scroll, before new lines grow the page, so a line arriving
 *  while the reader is there is followed and a line arriving while they read earlier text is not.
 *  The page scrolls the window itself (the shell has no inner scroll container). */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "./ui";
import type { LiveTranscriptMode } from "./useLiveTranscript";

/** How close to the end of the page still counts as "at the bottom", in px. */
const BOTTOM_SLACK_PX = 48;

function atBottom(): boolean {
  const doc = document.documentElement;
  return window.innerHeight + window.scrollY >= doc.scrollHeight - BOTTOM_SLACK_PX;
}

function scrollToEnd() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
}

/** `active` while the meeting is live; `contentKey` changes whenever the shown lines do;
 *  `startFollowing` is false when the page opened on a specific line (a search result link). */
export function useFollowLive(active: boolean, contentKey: string, startFollowing: boolean) {
  const [following, setFollowing] = useState(startFollowing);

  useEffect(() => {
    if (!active) return;
    const onScroll = () => setFollowing(atBottom());
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [active]);

  useLayoutEffect(() => {
    if (active && following) scrollToEnd();
    // `following` is read, not watched: a change of mind alone never scrolls the page.
  }, [active, contentKey]);

  const jumpToLive = useCallback(() => {
    setFollowing(true);
    scrollToEnd();
  }, []);

  return { following, jumpToLive };
}

/** The pill shown while the reader has scrolled away from the live end. */
export function JumpToLive({ onClick }: { onClick: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center print:hidden">
      <Button
        variant="primary"
        size="sm"
        onClick={onClick}
        icon={<ArrowDown size={14} aria-hidden />}
        className="pointer-events-auto rounded-full shadow-lg"
      >
        Jump to live
      </Button>
    </div>
  );
}

const MODE_TEXT: Record<Exclude<LiveTranscriptMode, "off">, string> = {
  connecting: "Connecting to the live transcript…",
  streaming: "Live — lines appear as they are spoken.",
  polling: "Live — the stream is unavailable, refreshing every 5 seconds.",
};

/** One line saying how the live transcript is arriving. */
export function LiveStatus({ mode }: { mode: LiveTranscriptMode }) {
  if (mode === "off") return null;
  return (
    <p role="status" data-live-mode={mode} className="mb-3 flex items-center gap-2 text-xs text-ink-3 print:hidden">
      <span
        aria-hidden
        className={"h-2 w-2 rounded-full " + (mode === "streaming" ? "animate-pulse bg-live" : "bg-ink-3")}
      />
      {MODE_TEXT[mode]}
    </p>
  );
}
