"use client";
/** Bot status + Stop recording (DB-41).
 *
 *  Status comes from `GET /bots/status` (the caller's currently-running bots) rather than only
 *  the meeting row's own `status`, per the task's own spec — it is the same source the list
 *  page's running-bots badge would read, so a meeting's live control panel agrees with it. When
 *  this meeting isn't in that list (bot already gone) the row's own status is shown instead.
 *
 *  A join-failure reason, when the producer recorded one, is rendered VERBATIM — never reworded
 *  or summarised here (AGENTS.md: the core owns the contract).
 *
 *  "Stop recording" is hidden entirely on a shared meeting (the viewer is not the owner) rather
 *  than shown-then-403'd — the client does not rely on the server's own refusal to hide a
 *  control a viewer was never going to be allowed to use.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Square } from "lucide-react";
import { ApiError, getJson, mutateJson, presentError } from "@/lib/api";
import type { Meeting, MeetingRowDTO } from "@/lib/meetings";
import { Button, Dialog, useToast } from "./ui";

const POLL_MS = 5_000;

export function BotControls({ meeting, onStopped }: { meeting: Meeting; onStopped: () => void }) {
  const [running, setRunning] = useState<MeetingRowDTO[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const body = await getJson<{ running?: MeetingRowDTO[] }>("/api/vexa/bots/status");
      setRunning(Array.isArray(body.running) ? body.running : []);
    } catch (e) {
      console.warn("bot status load failed", e);
    }
  }, []);

  useEffect(() => {
    if (meeting.phase !== "live") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [meeting.phase, load]);

  const canStop = meeting.phase === "live" && !meeting.shared && !!meeting.nativeId;
  if (!canStop && !meeting.joinFailureReason) return null;

  const liveRow = running?.find((r) => String(r.id) === meeting.id);
  const botStatus = liveRow?.status ?? meeting.status;

  async function stop() {
    if (!meeting.nativeId) return;
    setStopping(true);
    try {
      await mutateJson(
        "DELETE",
        `/api/vexa/bots/${encodeURIComponent(meeting.platformId)}/${encodeURIComponent(meeting.nativeId)}`,
      );
      toast.push({ tone: "success", title: "Stopping the recording." });
      setConfirmOpen(false);
      onStopped();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      toast.push({
        tone: "error",
        title: "Couldn't stop the recording",
        description: err ? presentError(err) : presentError(e),
      });
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="mb-6 rounded-card border border-line bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Bot</p>
          {canStop && <p className="text-xs text-ink-3">Status: {botStatus}</p>}
        </div>
        {canStop && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            icon={<Square size={13} aria-hidden />}
          >
            Stop recording
          </Button>
        )}
      </div>

      {meeting.joinFailureReason && (
        <p role="status" className="mt-3 flex items-start gap-1.5 rounded-lg bg-live-soft px-3 py-2 text-xs text-live">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
          {meeting.joinFailureReason}
        </p>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Stop recording?"
        description="The bot leaves the meeting immediately and the transcript ends at this point."
        icon={<Square size={16} aria-hidden />}
      >
        <div className="flex flex-col gap-4 p-6 pt-4">
          <p className="text-sm text-ink-2">
            This asks the bot to leave &quot;{meeting.title}&quot; now. It can&apos;t be undone — a new bot would
            have to be sent to keep transcribing.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={stopping}>
              Cancel
            </Button>
            <Button variant="danger" onClick={stop} loading={stopping}>
              {stopping ? "Stopping…" : "Stop recording"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
