"use client";
/** The Otter-style AI note, above the transcript (DB-60's dashboard half).
 *
 *  Reads `GET /api/vexa/meetings/<id>/summary` — the dashboard's own composed route onto
 *  `/agent/workspace/file?path=meetings/<id>/summary.md` (see `lib/upstream.ts`). The browser
 *  never sees that path; it only ever sends a numeric meeting id.
 *
 *  Five states, each rendered distinctly — never collapsed into a shared "no summary" message:
 *   - not yet ended (live/scheduled): a summary appears after the meeting ends.
 *   - a completed SHARED meeting (the viewer is not the owner): the note lives in the owner's
 *     workspace, not the viewer's — say so, rather than polling forever for something that will
 *     never arrive under this key.
 *   - pending (404 on a completed, owned meeting): "being generated", polled at a gentle
 *     interval, stopped the moment a real answer (any status) arrives.
 *   - skipped: the producer's own `reason`, in plain words.
 *   - complete: the four sections, action items as a list.
 *   - fetch error (anything but 404): the shared error state, with retry.
 *
 *  Rendering is plain React — no `dangerouslySetInnerHTML`, no markdown-to-HTML library. The
 *  note's shape is small and fixed (`lib/summary.ts`), so turning it into JSX directly is both
 *  simpler than pulling in a renderer and incapable of ever weakening the nonce-based CSP.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, ListChecks, RefreshCw, SkipForward, Sparkles } from "lucide-react";
import { ApiError, getJson, presentError } from "@/lib/api";
import { parseSummaryDoc, type SummaryDoc } from "@/lib/summary";
import type { Meeting } from "@/lib/meetings";
import { Button } from "./ui";

const POLL_MS = 20_000;

type PanelState =
  | { kind: "not-ended" }
  | { kind: "shared" }
  | { kind: "loading" }
  | { kind: "pending" }
  | { kind: "doc"; doc: SummaryDoc }
  | { kind: "error"; message: string };

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label="Meeting summary" className="mb-6 rounded-card border border-line bg-card p-5">
      {children}
    </section>
  );
}

function CardHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
      {icon}
      {title}
    </div>
  );
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function SectionText({ text }: { text: string }) {
  const parts = paragraphs(text);
  if (!parts.length) return <p className="text-sm text-ink-3">_none recorded in this meeting._</p>;
  return (
    <>
      {parts.map((p, i) => (
        <p key={i} className="text-[15px] leading-relaxed text-ink-2">
          {p}
        </p>
      ))}
    </>
  );
}

export function SummaryPanel({ meetingId, meeting }: { meetingId: string; meeting: Meeting }) {
  const ended = meeting.phase !== "live" && meeting.phase !== "scheduled";
  const [state, setState] = useState<PanelState>(ended && !meeting.shared ? { kind: "loading" } : { kind: "not-ended" });
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback(async (): Promise<boolean> => {
    try {
      const body = await getJson<{ content?: string }>(
        `/api/vexa/meetings/${encodeURIComponent(meetingId)}/summary`,
      );
      setState({ kind: "doc", doc: parseSummaryDoc(body.content ?? "") });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setState({ kind: "pending" });
        return false;
      }
      setState({ kind: "error", message: presentError(e) });
      return true; // stop the poll loop; the reader retries explicitly
    }
  }, [meetingId]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!ended) { setState({ kind: "not-ended" }); return; }
    if (meeting.shared) { setState({ kind: "shared" }); return; }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const arrived = await fetchOnce();
      if (cancelledRef.current) return;
      if (!arrived) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [ended, meeting.shared, fetchOnce]);

  function retry() {
    setState({ kind: "loading" });
    void fetchOnce();
  }

  if (state.kind === "not-ended") {
    return (
      <Card>
        <CardHeader icon={<Sparkles size={16} className="text-accent" aria-hidden />} title="Summary" />
        <p className="text-sm text-ink-3">A summary appears here once this meeting ends.</p>
      </Card>
    );
  }

  if (state.kind === "shared") {
    return (
      <Card>
        <CardHeader icon={<Sparkles size={16} className="text-accent" aria-hidden />} title="Summary" />
        <p className="text-sm text-ink-3">
          This meeting was shared with you. Its summary is available to the meeting&apos;s owner.
        </p>
      </Card>
    );
  }

  if (state.kind === "loading") {
    return (
      <Card>
        <CardHeader icon={<Sparkles size={16} className="text-accent" aria-hidden />} title="Summary" />
        <p role="status" className="text-sm text-ink-3">
          Loading…
        </p>
      </Card>
    );
  }

  if (state.kind === "pending") {
    return (
      <Card>
        <CardHeader icon={<Clock size={16} className="text-ink-3" aria-hidden />} title="Summary" />
        <p role="status" className="text-sm text-ink-3">
          The summary is still being generated. This updates automatically.
        </p>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <CardHeader icon={<AlertCircle size={16} className="text-live" aria-hidden />} title="Summary" />
        <p role="alert" className="mb-3 text-sm text-live">
          {state.message}
        </p>
        <Button variant="secondary" size="sm" onClick={retry} icon={<RefreshCw size={14} aria-hidden />}>
          Retry
        </Button>
      </Card>
    );
  }

  const { doc } = state;

  if (doc.kind === "malformed") {
    return (
      <Card>
        <CardHeader icon={<AlertCircle size={16} className="text-live" aria-hidden />} title="Summary" />
        <p role="alert" className="mb-3 text-sm text-live">
          The summary couldn&apos;t be read ({doc.detail}).
        </p>
        <Button variant="secondary" size="sm" onClick={retry} icon={<RefreshCw size={14} aria-hidden />}>
          Retry
        </Button>
      </Card>
    );
  }

  if (doc.kind === "skipped") {
    return (
      <Card>
        <CardHeader icon={<SkipForward size={16} className="text-ink-3" aria-hidden />} title="Summary" />
        <p className="text-sm text-ink-2">{doc.reason}</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader icon={<CheckCircle2 size={16} className="text-ok" aria-hidden />} title="Summary" />
      <div className="flex flex-col gap-5">
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Overview</h3>
          <SectionText text={doc.overview} />
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Decisions</h3>
          <SectionText text={doc.decisions} />
        </div>
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">
            <ListChecks size={13} aria-hidden />
            Action items
          </h3>
          {doc.actionItems.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-[15px] leading-relaxed text-ink-2">
              {doc.actionItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">{doc.actionItemsNote || "_none recorded in this meeting._"}</p>
          )}
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Open questions</h3>
          <SectionText text={doc.openQuestions} />
        </div>
      </div>
    </Card>
  );
}
