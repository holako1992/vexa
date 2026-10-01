"use client";
/** A meeting's tags: chips that link to the list filtered by that tag, and, for the owner, an
 *  input to add one and an × to remove one.
 *
 *  Tags are `data.metadata.tags` on the meeting row, written through
 *  `POST /meetings/<id>/annotate` with the whole list each time (the route merges metadata per
 *  key, so the list is replaced and nothing else is touched). Removing the last tag sends `null`,
 *  which deletes the key. Stored lower-case — see `normalizeTag`.
 */
import { useState } from "react";
import Link from "next/link";
import { Plus, Tag, X } from "lucide-react";
import { mutateJson, presentError } from "@/lib/api";
import { MAX_TAGS, MAX_TAG_CHARS, TAGS_KEY, normalizeTag } from "@/lib/annotations";
import { useToast } from "./ui";

export function tagHref(tag: string): string {
  return `/?tag=${encodeURIComponent(tag)}`;
}

export function TagChip({ tag, onRemove, busy }: { tag: string; onRemove?: () => void; busy?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs font-medium text-accent">
      <Link href={tagHref(tag)} className="hover:underline" aria-label={`Meetings tagged ${tag}`}>
        {tag}
      </Link>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove tag ${tag}`}
          className="rounded-full p-0.5 transition-colors hover:bg-accent/15 disabled:opacity-40"
        >
          <X size={12} aria-hidden />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}

export function MeetingTags({
  meetingId,
  tags,
  editable,
  onChange,
}: {
  meetingId: string;
  tags: readonly string[];
  editable: boolean;
  onChange: (tags: string[]) => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function write(next: string[]) {
    setBusy(true);
    try {
      await mutateJson("POST", `/api/vexa/meetings/${encodeURIComponent(meetingId)}/annotate`, {
        metadata: { [TAGS_KEY]: next.length ? next : null },
      });
      onChange(next);
      return true;
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't update tags", description: presentError(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const tag = normalizeTag(text);
    if (!tag) return;
    if (tags.includes(tag)) {
      setText("");
      return;
    }
    if (tags.length >= MAX_TAGS) {
      toast.push({ tone: "error", title: `A meeting can have at most ${MAX_TAGS} tags.` });
      return;
    }
    if (await write([...tags, tag])) {
      setText("");
      setAdding(false);
    }
  }

  if (!editable && !tags.length) return null;

  return (
    <div role="group" aria-label="Tags" className="mt-3 flex flex-wrap items-center gap-1.5">
      <Tag size={13} aria-hidden className="text-ink-3" />
      {tags.map((t) => (
        <TagChip
          key={t}
          tag={t}
          busy={busy}
          onRemove={editable ? () => void write(tags.filter((x) => x !== t)) : undefined}
        />
      ))}
      {editable && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-0.5 text-xs text-ink-2 transition-colors hover:bg-raised print:hidden"
        >
          <Plus size={12} aria-hidden />
          Add tag
        </button>
      )}
      {editable && adding && (
        <input
          aria-label="New tag"
          autoFocus
          value={text}
          maxLength={MAX_TAG_CHARS}
          disabled={busy}
          placeholder="tag name"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
            if (e.key === "Escape") {
              setAdding(false);
              setText("");
            }
          }}
          onBlur={() => {
            if (!text.trim()) setAdding(false);
          }}
          className="h-6 w-32 rounded-full border border-line bg-raised px-2.5 text-xs focus:border-accent focus:outline-none print:hidden"
        />
      )}
    </div>
  );
}
