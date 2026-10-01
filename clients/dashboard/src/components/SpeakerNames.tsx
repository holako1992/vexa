"use client";
/** Rename the transcript's speakers: "Speaker 1" becomes the person it was, on every line.
 *
 *  The names are a label map on the meeting (`data.metadata.speaker_labels`, written through
 *  `POST /meetings/<id>/annotate`), keyed by the producer's own speaker string. The transcript is
 *  never rewritten: clearing a name shows the producer's attribution again. One write carries the
 *  whole map, and an empty map is sent as `null` so the key is removed rather than stored empty.
 *
 *  Owner-only: a shared meeting's viewer sees the owner's names but gets no editor.
 */
import { useState } from "react";
import { UserPen } from "lucide-react";
import { mutateJson, presentError } from "@/lib/api";
import {
  MAX_SPEAKER_KEY_CHARS,
  MAX_SPEAKER_LABELS,
  MAX_SPEAKER_LABEL_CHARS,
  SPEAKER_LABELS_KEY,
  nextSpeakerLabels,
} from "@/lib/annotations";
import { Button, Dialog, Input, useToast } from "./ui";

export function SpeakerNames({
  meetingId,
  speakers: allSpeakers,
  labels,
  onSaved,
}: {
  meetingId: string;
  /** The producer's distinct speakers, in order of first appearance. */
  speakers: readonly string[];
  labels: Readonly<Record<string, string>>;
  onSaved: (labels: Record<string, string>) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // The label map's own bounds: a producer speaker string longer than a metadata key may be has no
  // label to carry, and the map holds at most MAX_SPEAKER_LABELS names.
  const speakers = allSpeakers.filter((s) => s.length <= MAX_SPEAKER_KEY_CHARS).slice(0, MAX_SPEAKER_LABELS);
  if (!speakers.length) return null;

  function openEditor() {
    setDraft(Object.fromEntries(speakers.map((s) => [s, Object.hasOwn(labels, s) ? labels[s]! : ""])));
    setOpen(true);
  }

  async function save() {
    const next = nextSpeakerLabels(labels, draft);
    setSaving(true);
    try {
      await mutateJson("POST", `/api/vexa/meetings/${encodeURIComponent(meetingId)}/annotate`, {
        metadata: { [SPEAKER_LABELS_KEY]: next },
      });
      toast.push({ tone: "success", title: "Speaker names saved." });
      setOpen(false);
      onSaved(next ?? {});
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't save speaker names", description: presentError(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={openEditor} icon={<UserPen size={15} aria-hidden />}>
        Speakers
      </Button>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="Name the speakers"
          description="Names apply to every line and to exports. Leave a name blank to show the original."
          icon={<UserPen size={16} aria-hidden />}
        >
          <form
            className="flex flex-col gap-4 p-6 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saving) void save();
            }}
          >
            <ul className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
              {speakers.map((s) => (
                <li key={s}>
                  <Input
                    label={s}
                    value={draft[s] ?? ""}
                    placeholder={s}
                    maxLength={MAX_SPEAKER_LABEL_CHARS}
                    onChange={(e) => setDraft((d) => ({ ...d, [s]: e.target.value }))}
                  />
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" loading={saving}>
                Save names
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
