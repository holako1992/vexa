"use client";
/** The status chip. It shows meeting-api's own status word — the dashboard picks the colour, never
 *  the vocabulary, so a status this client has never heard of still renders truthfully. */
import clsx from "clsx";
import type { MeetingPhase } from "@/lib/meetings";

const TONE: Record<MeetingPhase, string> = {
  live: "bg-live-soft text-live",
  scheduled: "bg-warn-soft text-warn",
  past: "bg-raised text-ink-2",
};

export function StatusPill({ phase, status }: { phase: MeetingPhase; status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium capitalize",
        TONE[phase],
      )}
    >
      {phase === "live" && <span className="live-dot h-1.5 w-1.5 rounded-full bg-live" aria-hidden />}
      {status.replace(/_/g, " ")}
    </span>
  );
}
