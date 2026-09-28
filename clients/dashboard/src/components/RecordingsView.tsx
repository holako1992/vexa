"use client";
/** `/recordings`: every recording the caller owns, newest first, from `GET
 *  /recordings` (meeting-api's own LIST projection — see `lib/recordings.ts`'s header comment for
 * why this never reads `GET /recordings/<id>`). Each row links to its meeting, where the
 * audio player and the click-a-segment-to-seek live; Download and Delete are here,
 *  on the row itself, since browsing and managing recordings — not playing one back — is this
 *  page's job.
 *
 * "Gated by plan": the entitlements resolver carries `limits.recording_retention_days`
 *  — how LONG a recording is kept, never a yes/no "can this account see recordings at all". Every
 *  plan in the catalog gets a recordings list, a player, a download and a delete button; this page
 *  only ever uses that number to show the retention note below, never to hide a control (see the
 * task's own report for the same finding — the contract has no boolean recordings flag to
 *  gate on, and this page does not invent one).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, Trash2, Video } from "lucide-react";
import { getJson, mutateJson, presentError } from "@/lib/api";
import { formatClock } from "@/lib/meetings";
import {
  type Recording,
  type RecordingsPageDTO,
  formatRecordedAt,
  formatRetention,
  toRecording,
} from "@/lib/recordings";
import type { Entitlements } from "@/lib/entitlements";
import { EmptyState, ErrorState, LoadingState } from "./EmptyState";
import { Button, Dialog, useToast } from "./ui";

const PAGE_SIZE = 50;

export function RecordingsView() {
  const toast = useToast();
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // `undefined` = not read yet (the note stays hidden rather than flashing a wrong default); a
  // failed entitlements read leaves it `undefined` too — this note is informational only, so a
  // read failure here must never block the list itself from rendering.
  const [retentionDays, setRetentionDays] = useState<number | null | undefined>(undefined);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await getJson<RecordingsPageDTO>(`/api/vexa/recordings?limit=${PAGE_SIZE}&offset=0`);
      setRecordings((body.recordings ?? []).map(toRecording));
      setHasMore(body.has_more ?? false);
      setError(null);
    } catch (e) {
      console.warn("recordings load failed", e);
      setError(presentError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    getJson<Entitlements>("/api/vexa/user/entitlements")
      .then((data) => {
        if (!cancelled) setRetentionDays(data.limits.recording_retention_days);
      })
      .catch((e) => console.warn("entitlements read failed (retention note hidden)", e));
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    if (!recordings) return;
    setLoadingMore(true);
    try {
      const body = await getJson<RecordingsPageDTO>(
        `/api/vexa/recordings?limit=${PAGE_SIZE}&offset=${recordings.length}`,
      );
      const page = (body.recordings ?? []).map(toRecording);
      setRecordings((prev) => [...(prev ?? []), ...page]);
      setHasMore(body.has_more ?? false);
    } catch (e) {
      console.warn("recordings load more failed", e);
      setError(presentError(e));
    } finally {
      setLoadingMore(false);
    }
  }

  async function doDelete(id: string) {
    setDeleting(true);
    try {
      await mutateJson("DELETE", `/api/vexa/recordings/${encodeURIComponent(id)}`);
      toast.push({ tone: "success", title: "Recording deleted." });
      setRecordings((prev) => prev?.filter((r) => r.id !== id) ?? prev);
      setConfirmId(null);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't delete this recording", description: presentError(e) });
    } finally {
      setDeleting(false);
    }
  }

  const confirmTarget = recordings?.find((r) => r.id === confirmId) ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-8 md:py-10">
      <header className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">Recordings</h1>
        <p className="mt-1 text-sm text-ink-2">Every meeting's audio, in one place.</p>
      </header>
      <p className="mb-6 text-xs text-ink-3">
        {retentionDays !== undefined ? `Your plan: ${formatRetention(retentionDays)}.` : " "}
      </p>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && recordings === null && <LoadingState label="Loading recordings…" />}
      {!error && recordings !== null && recordings.length === 0 && (
        <EmptyState
          title="No recordings yet."
          hint="Send a Vexa bot to a meeting and its audio will show up here once the meeting ends."
        />
      )}

      {!error && recordings !== null && recordings.length > 0 && (
        <ul className="space-y-2">
          {recordings.map((r) => (
            <li
              key={r.id}
              role="group"
              aria-label={`Recording from ${formatRecordedAt(r.createdAt)}`}
              className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-card px-4 py-3"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Video size={16} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/meetings/${encodeURIComponent(r.meetingId)}`} className="text-sm font-medium hover:underline">
                  {formatRecordedAt(r.createdAt)}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
                  <span>{r.status === "completed" ? "Recorded" : "Recording…"}</span>
                  {r.durationSeconds != null && <span>{formatClock(r.durationSeconds)}</span>}
                  {r.deletionPending && <span className="text-warn">Scheduled for deletion</span>}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {r.audioMediaFileId ? (
                  // A plain navigating link, not a fetch: the download route (`upstream.ts`'s
                  // `raw: true`) reads the session cookie server-side the same way any other page
                  // load does, and `download` tells the browser to save the bytes rather than try
                  // to render audio/wav inline. Styled to match `Button`'s secondary/sm — not
                  // built from it, since `Button` renders a `<button>` and this must be a real
                  // link (keyboard/middle-click/"open in new tab" all need to keep working).
                  <a
                    href={`/api/vexa/recordings/${encodeURIComponent(r.id)}/media/${encodeURIComponent(r.audioMediaFileId)}/download?type=audio`}
                    download
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-semibold text-ink-2 transition-colors hover:bg-raised"
                  >
                    <Download size={14} aria-hidden />
                    Download
                  </a>
                ) : null}
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} aria-hidden />}
                  onClick={() => setConfirmId(r.id)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!error && hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}

      <Dialog
        open={confirmTarget != null}
        onClose={() => setConfirmId(null)}
        title="Delete this recording?"
        icon={<Trash2 size={16} aria-hidden />}
      >
        <div className="flex flex-col gap-4 p-6 pt-4">
          <p className="text-sm text-ink-2">
            {confirmTarget
              ? `This permanently deletes the recording from ${formatRecordedAt(confirmTarget.createdAt)}. It can't be undone — backup copies still expire under this deployment's normal retention policy.`
              : ""}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmId(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => confirmTarget && void doDelete(confirmTarget.id)}
              loading={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
