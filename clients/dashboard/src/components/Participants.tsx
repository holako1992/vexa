"use client";
/** Who was in the meeting, as far as the 0.12 core actually knows (DB-42). Reads
 *  `GET /meetings/<platform>/<native>/participants`, which mixes two honest, distinct sources —
 *  `invite` (who was asked, from a calendar feed) and `speaker` (who was heard and named) — never
 *  merged, never inferred into attendance. A silent participant is absent by construction; the
 *  same person invited AND heard appears twice, once per source, because guessing they're the
 *  same person is exactly what meeting-api's own route comment says never to do.
 *
 *  Only fetched for a meeting that actually has a native id (a scheduled row with no dispatch yet
 *  has nothing to ask about). */
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { getJson } from "@/lib/api";
import type { Meeting } from "@/lib/meetings";

interface ParticipantRow {
  name: string | null;
  email: string | null;
  source: "invite" | "speaker";
  response_status?: string;
}

export function Participants({ meeting }: { meeting: Meeting }) {
  const [rows, setRows] = useState<ParticipantRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    if (!meeting.nativeId) return;
    let cancelled = false;
    getJson<{ participants?: ParticipantRow[] }>(
      `/api/vexa/meetings/${encodeURIComponent(meeting.platformId)}/${encodeURIComponent(meeting.nativeId)}/participants`,
    )
      .then((d) => {
        if (!cancelled) setRows(Array.isArray(d.participants) ? d.participants : []);
      })
      .catch((e) => {
        console.warn("participants load failed", e);
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [meeting.platformId, meeting.nativeId]);

  if (!meeting.nativeId || !rows || rows.length === 0) return null;

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
