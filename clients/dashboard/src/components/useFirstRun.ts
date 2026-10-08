"use client";
/** Reads where this account stands in the first-run welcome, and whether the welcome should open.
 *
 *  Two questions, asked in order and only as far as needed: the producer's `GET /user/first-run`
 *  (is this account new, and unfinished?), and — only for an account still at the first step —
 *  whether it has any meetings (`lib/firstRun.ts`'s `wizardShouldShow` says why). Most accounts
 *  stop at the first answer, so the common cost is one small request.
 *
 *  Every failure resolves to "no welcome": an answer that cannot be read is never guessed into
 *  one. `ready` flips once both questions are settled, so a caller that must wait for the decision
 *  (the OAuth return handler) can.
 */
import { useCallback, useEffect, useState } from "react";
import { getJson } from "@/lib/api";
import { type FirstRunStatus, parseFirstRunStatus, wizardShouldShow } from "@/lib/firstRun";

export interface FirstRun {
  ready: boolean;
  status: FirstRunStatus | null;
  /** The welcome should open (and, once it has, stays the caller's to latch). */
  visible: boolean;
  /** Record a state change the producer has just accepted, without asking again. */
  update: (next: FirstRunStatus) => void;
}

export function useFirstRun(): FirstRun {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<FirstRunStatus | null>(null);
  const [meetingCount, setMeetingCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      let next: FirstRunStatus | null = null;
      try {
        next = parseFirstRunStatus(await getJson<unknown>("/api/vexa/user/first-run"));
      } catch {
        next = null;
      }
      let count: number | null = null;
      if (next && next.state === "active" && next.step === "name") {
        try {
          const page = await getJson<{ meetings?: unknown[] }>("/api/vexa/meetings?limit=1&offset=0");
          count = Array.isArray(page.meetings) ? page.meetings.length : null;
        } catch {
          count = null;
        }
      }
      if (cancelled) return;
      setStatus(next);
      setMeetingCount(count);
      setReady(true);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: FirstRunStatus) => setStatus(next), []);

  return { ready, status, visible: ready && wizardShouldShow(status, meetingCount), update };
}
