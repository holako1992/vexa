/** The live feed's pure half: the SSE parser, the cursor shape the proxy forwards, the event
 *  decoder, and the merge of streamed segments onto the REST transcript. Event payloads below are
 *  agent-api's `meeting_stream` shapes (`core/agent/control_plane/api.py`, `seg_events` and
 *  `retract_event`), so a drift in either side shows up here. */
import { describe, expect, it } from "vitest";
import {
  applyLiveOps,
  createSseParser,
  decodeLiveEvent,
  isLiveCursor,
  pruneLiveOps,
  type LiveOp,
  type SseMessage,
} from "../liveTranscript";
import type { SegmentDTO } from "../meetings";

function parseAll(...chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  for (const c of chunks) p.push(c);
  return out;
}

describe("createSseParser", () => {
  it("dispatches one message per blank line, carrying the id in force", () => {
    expect(parseAll('id: 1-0|$|0-0\ndata: {"type":"ping"}\n\n')).toEqual([{ data: '{"type":"ping"}', id: "1-0|$|0-0" }]);
  });

  it("reassembles messages split anywhere across chunks, CRLF included", () => {
    const msgs = parseAll("id: 1-0|$|0", "-0\r", "\ndata: {\"a\"", ":1}\r\n\r\n", "data: x\n", "\n");
    expect(msgs).toEqual([
      { data: '{"a":1}', id: "1-0|$|0-0" },
      { data: "x", id: "1-0|$|0-0" },
    ]);
  });

  it("ignores comments (the producer's keepalive) and dispatches nothing for an empty message", () => {
    expect(parseAll(": keepalive\n\n", "\n\n", "id: 5-0|-\n\n")).toEqual([]);
  });

  it("joins multi-line data with newlines", () => {
    expect(parseAll("data: a\ndata: b\n\n")[0]?.data).toBe("a\nb");
  });

  it("yields nothing for the gateway's wrapped refusal (a JSON body, no SSE fields)", () => {
    expect(parseAll('{"detail":"not authorized for this meeting"}')).toEqual([]);
  });
});

describe("isLiveCursor", () => {
  it("admits the cursors the producer mints", () => {
    for (const c of ["1727000000000-0|$|0-0", "$|$|0-0", "-|-", "1-2|3-4", "1-2|-|5-6", "17-0|$"]) {
      expect(isLiveCursor(c)).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const c of [
      "", "abc", "1-2", "1|2", "1-2|3-4|5-6|7-8", "1-2|x", "1-2|$\r\nX-Evil: 1", "1-2|$ ", " 1-2|$",
      "1-2||$", "|", "1-2|3-4|", "-1-2|$", `${"1".repeat(21)}-0|$`, `${"1-0|".repeat(60)}$`, null, undefined,
    ]) {
      expect(isLiveCursor(c as string)).toBe(false);
    }
  });
});

describe("decodeLiveEvent", () => {
  it("maps a transcript event onto the REST segment's field names", () => {
    const ev = decodeLiveEvent(
      JSON.stringify({ type: "transcript", speaker: "Amy", text: "hello", t: 12.5, tsMs: 12500, completed: false, id: "seg-1" }),
    );
    expect(ev).toEqual({
      type: "transcript",
      segment: { segment_id: "seg-1", speaker: "Amy", text: "hello", start: 12.5, end: null, completed: false },
    });
  });

  it("treats a missing `completed` as confirmed, the producer's own default", () => {
    const ev = decodeLiveEvent(JSON.stringify({ type: "transcript", speaker: "Amy", text: "x", t: 1, id: "s" }));
    expect(ev?.type === "transcript" && ev.segment.completed).toBe(true);
  });

  it("refuses a transcript event without a segment id — it could never be updated or retracted", () => {
    expect(decodeLiveEvent(JSON.stringify({ type: "transcript", speaker: "Amy", text: "x", t: 1 }))).toBeNull();
    expect(decodeLiveEvent(JSON.stringify({ type: "transcript", speaker: "Amy", text: "x", t: 1, id: "" }))).toBeNull();
  });

  it("decodes retract (keeping only string ids) and meeting-end", () => {
    expect(decodeLiveEvent(JSON.stringify({ type: "retract", segment_ids: ["a", 7, "", "b"] }))).toEqual({
      type: "retract",
      segmentIds: ["a", "b"],
    });
    expect(decodeLiveEvent(JSON.stringify({ type: "retract", segment_ids: [] }))).toBeNull();
    expect(decodeLiveEvent(JSON.stringify({ type: "meeting-end" }))).toEqual({ type: "meeting-end" });
  });

  it("ignores the copilot's and the transport's events, and malformed payloads", () => {
    for (const data of [
      JSON.stringify({ type: "ping" }),
      JSON.stringify({ type: "card", card: { kind: "person", title: "Amy" } }),
      JSON.stringify({ type: "note", note: { id: "n", text: "t" } }),
      JSON.stringify({ type: "message-delta", text: "thinking" }),
      JSON.stringify({ type: "tool-call", name: "x" }),
      "not json",
      "[]",
      "null",
    ]) {
      expect(decodeLiveEvent(data)).toBeNull();
    }
  });
});

function op(seq: number, event: LiveOp["event"]): LiveOp {
  return { seq, event };
}
function seg(id: string, text: string, start: number, completed = true): LiveOp["event"] {
  return { type: "transcript", segment: { segment_id: id, speaker: "Amy", text, start, end: null, completed } };
}

describe("applyLiveOps", () => {
  const base: SegmentDTO[] = [
    { segment_id: "a", speaker: "Amy", text: "one", start: 0, end: 2, completed: true },
    { segment_id: "b", speaker: "Ben", text: "two", start: 3, end: 5, completed: false },
  ];

  it("returns the base itself when nothing streamed", () => {
    expect(applyLiveOps(base, [])).toBe(base);
  });

  it("replaces a known segment in place — a draft refined, then confirmed, never duplicated", () => {
    const out = applyLiveOps(base, [op(1, seg("b", "two and", 3, false)), op(2, seg("b", "two and three", 3, true))]);
    expect(out.map((s) => s.text)).toEqual(["one", "two and three"]);
    expect(out[1]?.completed).toBe(true);
  });

  it("appends new segments in arrival order, never re-sorting by time", () => {
    const out = applyLiveOps(base, [op(1, seg("d", "late", 9)), op(2, seg("c", "early", 6))]);
    expect(out.map((s) => s.segment_id)).toEqual(["a", "b", "d", "c"]);
  });

  it("removes retracted segments, and a later event for a retracted id appends it afresh", () => {
    const out = applyLiveOps(base, [
      op(1, seg("c", "three", 6)),
      op(2, { type: "retract", segmentIds: ["b", "zzz"] }),
      op(3, seg("c", "three!", 6)),
      op(4, seg("b", "two again", 3)),
    ]);
    expect(out.map((s) => `${s.segment_id}:${s.text}`)).toEqual(["a:one", "c:three!", "b:two again"]);
  });

  it("never mutates the base", () => {
    const copy = JSON.parse(JSON.stringify(base));
    applyLiveOps(base, [op(1, seg("a", "changed", 0)), op(2, { type: "retract", segmentIds: ["b"] })]);
    expect(base).toEqual(copy);
  });
});

describe("pruneLiveOps", () => {
  it("keeps only events that arrived after the REST read was issued", () => {
    const ops = [op(1, seg("a", "x", 0)), op(2, seg("b", "y", 1)), op(3, seg("c", "z", 2))];
    expect(pruneLiveOps(ops, 2).map((o) => o.seq)).toEqual([3]);
    expect(pruneLiveOps(ops, 0)).toHaveLength(3);
    expect(pruneLiveOps(ops, 3)).toEqual([]);
  });
});
