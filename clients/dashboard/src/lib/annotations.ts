/** The two caller-owned annotations the dashboard writes onto a meeting: its tags and its
 *  speaker names.
 *
 *  Both live in the meeting row's `data.metadata`, written through meeting-api's
 *  `POST /meetings/<id>/annotate` (`meeting_api/collector/app.py`). That route merges `metadata`
 *  key by key, so the dashboard owns exactly two keys and never touches any other an agent or
 *  integration may have written:
 *
 *    tags            → string[]                 the meeting's labels, lower-case, unique
 *    speaker_labels  → { [producer speaker]: name }  the person behind each transcribed speaker
 *
 *  The transcript itself is never rewritten. A speaker label is a display name keyed by the
 *  producer's own speaker string, applied when the transcript is shown or exported; removing the
 *  label shows the producer's attribution again, unchanged.
 *
 *  Pure and dependency-free: `upstream.ts` uses the same shape checks to refuse any other
 *  annotate body before it reaches the gateway, and the readers below use them to ignore a
 *  malformed value another writer left behind rather than render it.
 */

export const TAGS_KEY = "tags";
export const SPEAKER_LABELS_KEY = "speaker_labels";

export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 32;
export const MAX_SPEAKER_LABELS = 50;
export const MAX_SPEAKER_KEY_CHARS = 128;
export const MAX_SPEAKER_LABEL_CHARS = 80;
export const MAX_TITLE_CHARS = 512;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A typed tag in its stored form: trimmed, inner whitespace collapsed, lower-case. `null` when
 *  nothing usable is left or it is over the length bound. Lower-case because the list filter is a
 *  JSONB containment match, which is case-sensitive: "Acme" and "acme" must be one tag. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (!t || t.length > MAX_TAG_CHARS || CONTROL_CHARS.test(t)) return null;
  return t;
}

function isStoredTag(v: unknown): v is string {
  return typeof v === "string" && normalizeTag(v) === v;
}

/** A complete tag list as written: every entry already normalized, no duplicates, bounded. */
export function isTagList(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > MAX_TAGS) return false;
  if (!v.every(isStoredTag)) return false;
  return new Set(v).size === v.length;
}

/** The tags on a meeting's metadata. Entries that are not a stored tag are skipped, so a value
 *  another writer put under `tags` can never break the list. */
export function tagsOf(metadata: unknown): string[] {
  if (!isPlainObject(metadata)) return [];
  const raw = metadata[TAGS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (isStoredTag(t) && !out.includes(t)) out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

function isSpeakerKey(k: string): boolean {
  return k.length >= 1 && k.length <= MAX_SPEAKER_KEY_CHARS && !CONTROL_CHARS.test(k);
}

function isSpeakerLabel(v: unknown): v is string {
  return (
    typeof v === "string" && v.length >= 1 && v.length <= MAX_SPEAKER_LABEL_CHARS &&
    v.trim() === v && !CONTROL_CHARS.test(v)
  );
}

/** A complete speaker-label map as written: bounded, every key a producer speaker string and
 *  every value a trimmed, non-empty name. */
export function isSpeakerLabelMap(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false;
  const entries = Object.entries(v);
  if (entries.length > MAX_SPEAKER_LABELS) return false;
  return entries.every(([k, label]) => isSpeakerKey(k) && isSpeakerLabel(label));
}

/** The speaker labels on a meeting's metadata, with malformed entries skipped. Built with
 *  `Object.fromEntries` so a producer speaker literally named `__proto__` is an own key, never a
 *  prototype write. */
export function speakerLabelsOf(metadata: unknown): Record<string, string> {
  if (!isPlainObject(metadata)) return {};
  const raw = metadata[SPEAKER_LABELS_KEY];
  if (!isPlainObject(raw)) return {};
  const kept = Object.entries(raw)
    .filter(([k, label]) => isSpeakerKey(k) && isSpeakerLabel(label))
    .slice(0, MAX_SPEAKER_LABELS);
  return Object.fromEntries(kept) as Record<string, string>;
}

/** The name to show for a producer speaker: its label when one is set, else the speaker itself.
 *  `Object.hasOwn`, so a speaker named `constructor` reads as unlabelled rather than as
 *  `Object.prototype.constructor`. */
export function labelFor(labels: Readonly<Record<string, string>>, speaker: string): string {
  return Object.hasOwn(labels, speaker) ? labels[speaker]! : speaker;
}

/** The next speaker-label map after editing: `edits` maps a producer speaker to what the person
 *  typed. A blank entry, or one equal to the producer's own name, removes that label. `null` when
 *  nothing is left, which the annotate route reads as "delete the key". */
export function nextSpeakerLabels(
  current: Readonly<Record<string, string>>,
  edits: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const merged = new Map(Object.entries(current));
  for (const [speaker, typed] of Object.entries(edits)) {
    const name = typed.trim().replace(/\s+/g, " ");
    if (!name || name === speaker) merged.delete(speaker);
    else merged.set(speaker, name.slice(0, MAX_SPEAKER_LABEL_CHARS));
  }
  return merged.size ? Object.fromEntries(merged) : null;
}

/** The annotate bodies the dashboard sends, and nothing else: a rename (`{title}`), or exactly one
 *  of its two metadata keys set to a well-formed value or `null`. Any other metadata key, a
 *  second key, or a malformed value is refused here so the browser can never write the rest of
 *  the row's metadata through this client. */
export function isAnnotateBody(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return false;
  if (keys[0] === "title") {
    const t = parsed.title;
    return typeof t === "string" && t.length <= MAX_TITLE_CHARS;
  }
  if (keys[0] !== "metadata") return false;
  const md = parsed.metadata;
  if (!isPlainObject(md)) return false;
  const mdKeys = Object.keys(md);
  if (mdKeys.length !== 1) return false;
  const value = md[mdKeys[0]!];
  if (mdKeys[0] === TAGS_KEY) return value === null || (isTagList(value) && value.length > 0);
  if (mdKeys[0] === SPEAKER_LABELS_KEY) {
    return value === null || (isSpeakerLabelMap(value) && Object.keys(value).length > 0);
  }
  return false;
}

/** The `metadata` list-filter value for one tag — meeting-api's `GET /meetings?metadata=<json>`
 *  containment filter, evaluated in SQL across every meeting rather than on a loaded page. */
export function tagFilterValue(tag: string): string {
  return JSON.stringify({ [TAGS_KEY]: [tag] });
}

/** The only `metadata` filter the dashboard forwards: exactly `{"tags": [<one stored tag>]}`. */
export function isTagFilterValue(v: string): boolean {
  if (v.length > 256) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== TAGS_KEY) return false;
  const tags = parsed[TAGS_KEY];
  return Array.isArray(tags) && tags.length === 1 && isStoredTag(tags[0]);
}
