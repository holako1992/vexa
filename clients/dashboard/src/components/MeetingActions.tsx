"use client";
/** Inline rename + delete, the two mutations a meeting's own owner can make from its header
 *  (DB-42). Both are hidden outright on a shared meeting — the viewer is not the owner, and the
 *  client does not rely on the server's own 403 to hide a control that was never going to work.
 *
 *  Rename writes through `POST /meetings/<id>/annotate` (`{title}`), not `PATCH /meetings/<id>`:
 *  meeting-api's PATCH only accepts a still-`idle`/`scheduled` row (`update_planned_meeting`,
 *  `core/meetings/services/meeting-api/src/meeting_api/collector/adapters.py`) and answers 409
 *  ("Meeting is no longer planned") for anything a bot has already touched — which is most of
 *  what this page shows. `annotate` writes the same `title` field and works in ANY status,
 *  because it is the caller's own description rather than a dispatch instruction the FSM owns
 *  (see the route's own comment in `meeting_api/collector/app.py`). Adapting to that real
 *  contract, rather than a route that would 409 on a completed meeting, is the point-of-
 *  introduction fix AGENTS.md asks for.
 *
 *  Delete calls `DELETE /meetings/<id>`, which meeting-api itself splits in two ways depending on
 *  status: a still-planned row is removed outright; a completed/failed row instead has its
 *  transcript and recordings wiped (`Transcription` rows deleted, `recordings`/`processed`/
 *  `notes`/shares cleared from `data`) while the row itself stays, marked
 *  `artifact_deletion: {state: "completed"}` — backup residuals expire under the deployment's own
 *  retention policy. The confirm dialog names both outcomes rather than picking one, since this
 *  page cannot always tell in advance which branch a given meeting will take.
 */
import { useEffect, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { mutateJson, presentError } from "@/lib/api";
import type { Meeting } from "@/lib/meetings";
import { Button, Dialog, Input, useToast } from "./ui";

export function MeetingActions({
  meeting,
  onRenamed,
  onDeleted,
}: {
  meeting: Meeting;
  onRenamed: (title: string) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!editing) setTitle(meeting.title);
  }, [meeting.title, editing]);

  if (meeting.shared) return null;

  async function saveRename() {
    const trimmed = title.trim();
    if (!trimmed || trimmed === meeting.title) {
      setEditing(false);
      setTitle(meeting.title);
      return;
    }
    setSaving(true);
    try {
      await mutateJson("POST", `/api/vexa/meetings/${encodeURIComponent(meeting.id)}/annotate`, { title: trimmed });
      toast.push({ tone: "success", title: "Meeting renamed." });
      setEditing(false);
      onRenamed(trimmed);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't rename this meeting", description: presentError(e) });
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await mutateJson("DELETE", `/api/vexa/meetings/${encodeURIComponent(meeting.id)}`);
      toast.push({ tone: "success", title: "Meeting deleted." });
      onDeleted();
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't delete this meeting", description: presentError(e) });
      setDeleting(false);
      setConfirmOpen(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="Meeting title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !saving) void saveRename();
            if (e.key === "Escape") {
              setEditing(false);
              setTitle(meeting.title);
            }
          }}
          autoFocus
          maxLength={512}
          className="h-9 py-1 text-lg font-semibold"
        />
        <button
          type="button"
          aria-label="Save title"
          disabled={saving}
          onClick={() => void saveRename()}
          className="rounded-lg p-1.5 text-ok transition-colors hover:bg-ok-soft disabled:opacity-40"
        >
          <Check size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Cancel rename"
          disabled={saving}
          onClick={() => {
            setEditing(false);
            setTitle(meeting.title);
          }}
          className="rounded-lg p-1.5 text-ink-2 transition-colors hover:bg-raised disabled:opacity-40"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Rename meeting"
        onClick={() => setEditing(true)}
        className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-raised hover:text-ink-2"
      >
        <Pencil size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Delete meeting"
        onClick={() => setConfirmOpen(true)}
        className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-live-soft hover:text-live"
      >
        <Trash2 size={14} aria-hidden />
      </button>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Delete this meeting?"
        icon={<Trash2 size={16} aria-hidden />}
      >
        <div className="flex flex-col gap-4 p-6 pt-4">
          <p className="text-sm text-ink-2">
            {meeting.phase === "scheduled"
              ? `This removes "${meeting.title}" from your meetings. It can't be undone.`
              : `This permanently deletes the transcript and any recording for "${meeting.title}". It can't be undone — backup copies still expire under this deployment's normal retention policy.`}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void doDelete()} loading={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
