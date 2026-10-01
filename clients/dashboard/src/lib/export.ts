/** Transcript exports: SubRip (.srt), WebVTT (.vtt), Markdown (.md) and Word (.docx).
 *
 *  Every format is built from the same `TranscriptLine[]` the meeting page renders: speaker names
 *  as shown (labels applied), the producer's order, no line merged or dropped. An export never
 *  re-fetches or re-derives anything.
 *
 *  Pure and dependency-free. The .docx is a minimal WordprocessingML package (three parts) in a
 *  stored ZIP container written here, so no document library enters the shipped bundle.
 */
import { formatClock, type TranscriptLine } from "./meetings";

export type ExportFormat = "txt" | "srt" | "vtt" | "md" | "docx";

export const EXPORT_MIME: Record<ExportFormat, string> = {
  txt: "text/plain;charset=utf-8",
  srt: "application/x-subrip;charset=utf-8",
  vtt: "text/vtt;charset=utf-8",
  md: "text/markdown;charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** A download file name from a meeting title: word characters, dots and dashes only. */
export function exportFileName(title: string, format: ExportFormat): string {
  const base = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "transcript";
  return `${base}.${format}`;
}

/** How long a cue lasts when the producer gave no end and no later line bounds it. */
const FALLBACK_CUE_SECONDS = 3;

export interface Cue {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/** One cue per line, in order. A line with no start offset inherits the previous cue's start
 *  (0 for the first), so a subtitle file carries every line the page shows. The end is the
 *  producer's own when it is after the start; otherwise the next timed line's start; otherwise a
 *  short fixed length. */
export function toCues(lines: readonly TranscriptLine[]): Cue[] {
  const starts: number[] = [];
  let prev = 0;
  for (const l of lines) {
    const s = l.at != null && l.at >= 0 ? l.at : prev;
    starts.push(s);
    prev = s;
  }
  return lines.map((l, i) => {
    const start = starts[i]!;
    let end: number | null = l.end != null && l.end > start ? l.end : null;
    if (end == null) {
      for (let j = i + 1; j < lines.length; j++) {
        if (starts[j]! > start) {
          end = starts[j]!;
          break;
        }
      }
    }
    return { start, end: end ?? start + FALLBACK_CUE_SECONDS, speaker: l.speaker, text: oneLine(l.text) };
  });
}

/** Cue text on one line: a blank line inside a cue would end it early in both subtitle formats. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function clockParts(seconds: number): [string, string, string, string] {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return [p(h), p(m), p(s), p(rest, 3)];
}

/** `HH:MM:SS,mmm` — SubRip's timestamp. */
export function srtTimestamp(seconds: number): string {
  const [h, m, s, ms] = clockParts(seconds);
  return `${h}:${m}:${s},${ms}`;
}

/** `HH:MM:SS.mmm` — WebVTT's timestamp. */
export function vttTimestamp(seconds: number): string {
  const [h, m, s, ms] = clockParts(seconds);
  return `${h}:${m}:${s}.${ms}`;
}

export function transcriptToSrt(lines: readonly TranscriptLine[]): string {
  return toCues(lines)
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.speaker}: ${c.text}\n`)
    .join("\n");
}

/** WebVTT cue text escaping: `&`, `<` and `>` are markup there, and `-->` would end a timing. */
function vttEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** WebVTT with the speaker as a voice span (`<v Name>`), which players show as the speaker. */
export function transcriptToVtt(lines: readonly TranscriptLine[]): string {
  const cues = toCues(lines).map(
    (c) => `${vttTimestamp(c.start)} --> ${vttTimestamp(c.end)}\n<v ${vttEscape(c.speaker)}>${vttEscape(c.text)}\n`,
  );
  return `WEBVTT\n\n${cues.join("\n")}`;
}

/** CommonMark backslash-escapes for the characters that are markup mid-line: emphasis, code,
 *  links, raw HTML, tables and strikethrough. Every escaped value sits after a fixed prefix
 *  (`# `, `- **…:** `, `**…**: `), never at the start of a line, so block markers need none. */
function mdEscape(s: string): string {
  return oneLine(s).replace(/([\\`*_[\]<>|~])/g, "\\$1");
}

export interface ExportFact {
  label: string;
  value: string;
}

/** Markdown: the title as a heading, the meeting facts as a list, one paragraph per line. */
export function transcriptToMarkdown(title: string, facts: readonly ExportFact[], lines: readonly TranscriptLine[]): string {
  const head = [`# ${mdEscape(title)}`, ""];
  if (facts.length) {
    head.push(...facts.map((f) => `- **${mdEscape(f.label)}:** ${mdEscape(f.value)}`), "");
  }
  const body = lines.map((l) => {
    const at = l.at != null ? ` \\[${formatClock(l.at)}\\]` : "";
    return `**${mdEscape(l.speaker)}**${at}: ${mdEscape(l.text)}`;
  });
  return `${[...head, ...body.flatMap((b) => [b, ""])].join("\n").trimEnd()}\n`;
}

// --- .docx -----------------------------------------------------------------------------------

/** Characters XML 1.0 cannot carry at all; Word refuses a document containing one. */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xmlEscape(s: string): string {
  return s
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(text: string, props = ""): string {
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function paragraph(runs: string, spacingAfter = 160): string {
  return `<w:p><w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr>${runs}</w:p>`;
}

/** The body of `word/document.xml`: a bold title, the facts, then one paragraph per line with
 *  the speaker and offset in bold. Exported for the test, which reads the text back out. */
export function docxDocumentXml(title: string, facts: readonly ExportFact[], lines: readonly TranscriptLine[]): string {
  const parts = [paragraph(run(title, '<w:b/><w:sz w:val="36"/>'), 240)];
  for (const f of facts) parts.push(paragraph(run(`${f.label}: `, '<w:b/>') + run(f.value), 40));
  if (facts.length) parts.push(paragraph("", 120));
  for (const l of lines) {
    const head = `${l.speaker}${l.at != null ? ` [${formatClock(l.at)}]` : ""}: `;
    parts.push(paragraph(run(head, "<w:b/>") + run(oneLine(l.text))));
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${parts.join("")}<w:sectPr/></w:body></w:document>`
  );
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

export function transcriptToDocx(title: string, facts: readonly ExportFact[], lines: readonly TranscriptLine[]): Uint8Array {
  const enc = new TextEncoder();
  return zipStored([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES_XML) },
    { name: "_rels/.rels", data: enc.encode(ROOT_RELS_XML) },
    { name: "word/document.xml", data: enc.encode(docxDocumentXml(title, facts, lines)) },
  ]);
}

// --- a stored (uncompressed) ZIP writer --------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A ZIP archive with every entry STORED (method 0). Office reads stored packages; compression
 *  would only save bytes on a document that is already small. Timestamps are the DOS epoch so the
 *  same transcript always produces the same bytes. */
export function zipStored(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x0021, true); // date: 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
