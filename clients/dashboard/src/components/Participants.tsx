"use client";
/** Who was in the meeting, as far as the 0.12 core actually knows. Reads
 *  `GET /meetings/<platform>/<native>/participants`, which mixes two honest, distinct sources —
 *  `invite` (who was asked, from a calendar feed) and `speaker` (who was heard and named) — never
 *  merged, never inferred into attendance. A silent participant is absent by construction; the
 *  same person invited AND heard appears twice, once per source, because guessing they're the
 *  same person is exactly what meeting-api's own route comment says never to do.
 *
 *  Only fetched for a meeting that actually has a native id (a scheduled row with no dispatch yet
 *  has nothing to ask about). An empty roster (or a 404, the route's
 *  answer when it holds none) renders nothing — the header already lists the
 *  invitees it knows — but a failed read says so, with a retry, so "could not ask" never passes
 *  for "nobody was there". */
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw, Users } from "lucide-react";
import { ApiError, getJson, presentError } from "@/lib/api";
import type { Meeting } from "@/lib/meetings";
import { Button } from "./ui";

interface ParticipantRow {
  name: string | null;
  email: string | null;
  source: "invite" | "speaker";
  response_status?: string;
}

export function Participants({ meeting }: { meeting: Meeting }) {
  const [rows, setRows] = useState<ParticipantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    setRows(null);
    setError(null);
    if (!meeting.nativeId) return;
    let cancelled = false;
    getJson<{ participants?: ParticipantRow[] }>(
      `/api/vexa/meetings/${encodeURIComponent(meeting.platformId)}/${encodeURIComponent(meeting.nativeId)}/participants`,
    )
      .then((d) => {
        if (!cancelled) setRows(Array.isArray(d.participants) ? d.participants : []);
      })
      .catch((e) => {
        if (cancelled) return;
        // A 404 is meeting-api's answer for a meeting it holds no roster for.
        if (e instanceof ApiError && e.status === 404) {
          setRows([]);
          return;
        }
        console.warn("participants load failed", e);
        setError(presentError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [meeting.platformId, meeting.nativeId, attempt]);

  if (!meeting.nativeId) return null;

  if (error) {
    return (
      <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-live">
        <AlertCircle size={13} aria-hidden />
        <span>Couldn&apos;t load participants. {error}</span>
        <Button variant="ghost" size="sm" onClick={retry} icon={<RefreshCw size={12} aria-hidden />} aria-label="Retry loading participants">
          Retry
        </Button>
      </div>
    );
  }

  if (!rows || rows.length === 0) return null;

  return (
    <div className="mt-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">
        <Users size={12} aria-hidden />
        Participants
      </p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((p, i) => (
          <span
            key={`${p.source}-${p.email ?? p.name ?? i}`}
            className="rounded-full bg-raised px-2.5 py-1 text-xs text-ink-2"
            title={p.source === "invite" ? "Invited" : "Heard speaking"}
          >
            {p.name || p.email || "Unknown"}
            <span className="ml-1 text-ink-3">· {p.source}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
