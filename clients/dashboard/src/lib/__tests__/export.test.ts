/** Transcript exports. The property every format must keep is the meeting page's own: every line
 *  shown is in the file, in the same order, under the same speaker name — so each format is
 *  round-tripped back to its lines here, not just spot-checked for a header. */
import { describe, expect, it } from "vitest";
import {
  crc32,
  docxDocumentXml,
  exportFileName,
  srtTimestamp,
  toCues,
  transcriptToDocx,
  transcriptToMarkdown,
  transcriptToSrt,
  transcriptToVtt,
  vttTimestamp,
} from "../export";
import { type TranscriptLine, toTranscript } from "../meetings";

const LINES: TranscriptLine[] = toTranscript(
  [
    { start: 0, end: 4.2, speaker: "Speaker 1", text: "Let's start with the *new* flow." },
    { start: 8.5, speaker: "Speaker 2", text: "Sure — I pushed <b>mockups</b> & notes --> here." },
    { speaker: "Speaker 1", text: "No offset on this one." },
    { start: 3725.25, end: 3725, speaker: "", text: "Line\n\nbreaks inside." },
  ],
  { "Speaker 1": "Carla" },
);

/** Read entries back out of a stored ZIP — the inverse of `zipStored`, enough to prove the
 *  archive's own directory points at bytes that are what was written. */
function unzipStored(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(local + 26, true);
    const data = bytes.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, dec.decode(data));
    p += 46 + nameLen;
  }
  return out;
}

describe("timestamps", () => {
  it("formats SubRip and WebVTT clocks to the millisecond", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(3725.25)).toBe("01:02:05,250");
    expect(vttTimestamp(8.5)).toBe("00:00:08.500");
    expect(vttTimestamp(-1)).toBe("00:00:00.000");
  });
});

describe("toCues", () => {
  it("keeps every line, in order, under the shown speaker name", () => {
    const cues = toCues(LINES);
    expect(cues.map((c) => c.speaker)).toEqual(["Carla", "Speaker 2", "Carla", "Unknown speaker"]);
    expect(cues).toHaveLength(LINES.length);
  });

  it("uses the producer's end, else the next timed start, else a short fixed length", () => {
    const [a, b, c, d] = toCues(LINES);
    expect([a!.start, a!.end]).toEqual([0, 4.2]);
    expect([b!.start, b!.end]).toEqual([8.5, 3725.25]); // no end: runs to the next later start
    expect([c!.start, c!.end]).toEqual([8.5, 3725.25]); // no start: inherits the previous one
    expect([d!.start, d!.end]).toEqual([3725.25, 3728.25]); // end before start: ignored
  });

  it("puts a multi-line segment on one line, so it cannot end its cue early", () => {
    expect(toCues(LINES)[3]!.text).toBe("Line breaks inside.");
  });
});

describe("transcriptToSrt", () => {
  it("numbers cues from 1 and round-trips each line", () => {
    const srt = transcriptToSrt(LINES);
    const blocks = srt.trim().split(/\n\n/);
    expect(blocks).toHaveLength(LINES.length);
    expect(blocks[0]).toBe("1\n00:00:00,000 --> 00:00:04,200\nCarla: Let's start with the *new* flow.");
    blocks.forEach((b, i) => {
      const [n, , text] = b.split("\n");
      expect(n).toBe(String(i + 1));
      expect(text).toBe(`${LINES[i]!.speaker}: ${LINES[i]!.text.replace(/\s*\n+\s*/g, " ")}`);
    });
  });
});

describe("transcriptToVtt", () => {
  it("starts with the WEBVTT header and marks each speaker as a voice", () => {
    const vtt = transcriptToVtt(LINES);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:04.200\n<v Carla>Let's start with the *new* flow.");
  });

  it("escapes markup and a timing arrow inside cue text", () => {
    const vtt = transcriptToVtt(LINES);
    expect(vtt).toContain("<v Speaker 2>Sure — I pushed &lt;b&gt;mockups&lt;/b&gt; &amp; notes --&gt; here.");
    // The only arrows left are the timing lines' own.
    expect(vtt.match(/-->/g)).toHaveLength(LINES.length);
  });
});

describe("transcriptToMarkdown", () => {
  it("renders a heading, the facts and one paragraph per line, escaping inline markup", () => {
    const md = transcriptToMarkdown("Design *Review*", [{ label: "Platform", value: "Zoom" }], LINES);
    const paras = md.trim().split("\n\n");
    expect(paras[0]).toBe("# Design \\*Review\\*");
    expect(paras[1]).toBe("- **Platform:** Zoom");
    expect(paras.slice(2)).toEqual([
      "**Carla** \\[0:00\\]: Let's start with the \\*new\\* flow.",
      "**Speaker 2** \\[0:08\\]: Sure — I pushed \\<b\\>mockups\\</b\\> & notes --\\> here.",
      "**Carla**: No offset on this one.",
      "**Unknown speaker** \\[1:02:05\\]: Line breaks inside.",
    ]);
  });

  it("omits the facts list when there are none", () => {
    expect(transcriptToMarkdown("T", [], LINES.slice(0, 1))).toBe("# T\n\n**Carla** \\[0:00\\]: Let's start with the \\*new\\* flow.\n");
  });
});

describe("transcriptToDocx", () => {
  it("is a valid stored ZIP holding the three package parts", () => {
    const parts = unzipStored(transcriptToDocx("Design Review", [], LINES));
    expect([...parts.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    expect(parts.get("_rels/.rels")).toContain('Target="word/document.xml"');
    expect(parts.get("[Content_Types].xml")).toContain('PartName="/word/document.xml"');
  });

  it("round-trips every line's text, speaker and offset, XML-escaped", () => {
    const xml = unzipStored(transcriptToDocx("A & B", [{ label: "Platform", value: "Zoom" }], LINES)).get("word/document.xml")!;
    const texts = [...xml.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)].map((m) => m[1]);
    expect(texts).toEqual([
      "A &amp; B",
      "Platform: ", "Zoom",
      "Carla [0:00]: ", "Let's start with the *new* flow.",
      "Speaker 2 [0:08]: ", "Sure — I pushed &lt;b&gt;mockups&lt;/b&gt; &amp; notes --&gt; here.",
      "Carla: ", "No offset on this one.",
      "Unknown speaker [1:02:05]: ", "Line breaks inside.",
    ]);
  });

  it("drops characters XML cannot carry rather than producing a file Word refuses", () => {
    const xml = docxDocumentXml("T\u0001", [], toTranscript([{ speaker: "A", text: "bell\u0007 ok" }]));
    expect(xml).not.toMatch(/[\u0000-\u0008]/);
    expect(xml).toContain(">bell ok<");
  });

  it("is byte-identical for the same transcript", () => {
    expect(transcriptToDocx("T", [], LINES)).toEqual(transcriptToDocx("T", [], LINES));
  });
});

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("exportFileName", () => {
  it("keeps word characters, dots and dashes, with an honest fallback", () => {
    expect(exportFileName("Design Review / Q3", "srt")).toBe("Design-Review-Q3.srt");
    expect(exportFileName("???", "docx")).toBe("transcript.docx");
  });
});
