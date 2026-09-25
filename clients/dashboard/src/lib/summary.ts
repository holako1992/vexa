/** Parse the `summary.v1` note DB-60 writes to a completed meeting's workspace
 *  (`meetings/<row_id>/summary.md`, `docs/docs/how-to/post-meeting-report.mdx`).
 *
 *  Dependency-free and pure, like `upstream.ts` — no markdown/yaml library. The document shape
 *  is small and fixed (a four-key front-matter block plus four `##` sections), so a tiny
 *  purpose-built parser is both simpler and safer than a general one: it never interprets raw
 *  HTML, so there is nothing here that could weaken the app's nonce-based CSP. Rendering stays
 *  plain React (`SummaryPanel.tsx`) — this module only produces data, never markup.
 */

export interface SummaryFrontMatter {
  meetingId: string;
  status: "complete" | "skipped";
  generatedAt: string | null;
}

export type SummaryDoc =
  | ({ kind: "complete"; overview: string; decisions: string; actionItems: string[]; actionItemsNote: string | null; openQuestions: string } & SummaryFrontMatter)
  | ({ kind: "skipped"; reason: string } & SummaryFrontMatter)
  | { kind: "malformed"; detail: string };

const REQUIRED_SECTIONS = ["Overview", "Decisions", "Action items", "Open questions"] as const;

/** Parse one `summary.md`'s raw text. Never throws — every failure mode is a `{kind:
 *  "malformed"}` value the caller renders as its own distinct state. */
export function parseSummaryDoc(raw: string): SummaryDoc {
  if (typeof raw !== "string" || !raw.trim()) return { kind: "malformed", detail: "empty document" };
  const text = raw.replace(/\r\n/g, "\n").trimStart();

  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { kind: "malformed", detail: "missing front matter" };
  const frontMatter = match[1] ?? "";
  const body = match[2] ?? "";

  const fields = parseFrontMatter(frontMatter);
  if (fields.type !== "meeting-summary") {
    return { kind: "malformed", detail: `unrecognized front-matter type '${fields.type ?? ""}'` };
  }
  if (fields.version !== "v1") {
    return { kind: "malformed", detail: `unsupported summary version '${fields.version ?? ""}'` };
  }
  if (fields.status !== "complete" && fields.status !== "skipped") {
    return { kind: "malformed", detail: `missing or invalid status '${fields.status ?? ""}'` };
  }

  const meta: SummaryFrontMatter = {
    meetingId: fields.meeting_id ?? "",
    status: fields.status,
    generatedAt: fields.generated_at ?? null,
  };

  if (fields.status === "skipped") {
    if (!fields.reason) return { kind: "malformed", detail: "skipped summary carries no reason" };
    return { kind: "skipped", ...meta, reason: fields.reason };
  }

  const sections = splitSections(body);
  for (const name of REQUIRED_SECTIONS) {
    if (!(name in sections)) return { kind: "malformed", detail: `missing section '${name}'` };
  }
  const actionText = sections["Action items"]!;
  const actionItems = bulletsOf(actionText);
  return {
    kind: "complete",
    ...meta,
    overview: sections["Overview"]!.trim(),
    decisions: sections["Decisions"]!.trim(),
    actionItems,
    actionItemsNote: actionItems.length ? null : actionText.trim(),
    openQuestions: sections["Open questions"]!.trim(),
  };
}

/** `key: value` lines only — good enough for this document's flat, known key set. A quoted
 *  value (`reason: "too short"`) has its quotes stripped; anything else is taken verbatim. */
function parseFrontMatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = (m[2] ?? "").trim();
    if (value.length >= 2) {
      const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (quoted) value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Split the body on `## Heading` lines into `{heading: content}`, trimmed. A heading with no
 *  content (the next `##` immediately follows) maps to `""`, not absent — that distinction is
 *  what lets the caller tell "missing section" from "empty section". */
function splitSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^##\s+(.+?)\s*$/gm;
  const heads: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) heads.push({ name: m[1]!.trim(), start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < heads.length; i++) {
    const stop = i + 1 < heads.length ? heads[i + 1]!.start : body.length;
    out[heads[i]!.name] = body.slice(heads[i]!.end, stop).trim();
  }
  return out;
}

/** `- item` / `* item` lines within a section's text, in order. Returns `[]` when the section
 *  has no bullets (e.g. the `_none recorded in this meeting._` placeholder) — the caller falls
 *  back to showing that text directly rather than an empty list. */
function bulletsOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}
