/** The live transcript feed, read off the core's own SSE contract.
 *
 *  The producer is agent-api's `GET /api/meeting/stream` (fronted by the gateway as
 *  `GET /agent/meeting/stream`, reached here through `/api/vexa/meetings/<id>/stream`). It writes
 *  one unnamed SSE message per event — `id: <cursor>` then `data: <json>` — and the JSON's own
 *  `type` names the event. This client reads two of them, and only two:
 *
 *   • `transcript` — `{speaker, text, t, tsMs, completed, id}`: one segment, keyed by the
 *     producer's `segment_id` (`id`). A pending draft (`completed: false`) is re-sent under the
 *     same id as speech is refined and again when confirmed, so a repeat REPLACES its segment.
 *   • `retract`    — `{segment_ids}`: the producer withdrew those drafts; they leave the view.
 *
 *  plus `meeting-end`, which closes the feed. Everything else on that stream (`card`, `note`,
 *  `message-delta`, `tool-call`, `ping`) is the copilot's or the transport's, not the transcript's,
 *  and is ignored here.
 *
 *  The cursor (`<transcript>|<output>[|<processed>]`, each part a redis stream id, `$` or `-`) is
 *  echoed back as `Last-Event-ID` on reconnect so the producer resumes exactly where this client
 *  stopped reading. `isLiveCursor` is the shape check the proxy applies before forwarding one.
 *
 *  Pure and dependency-free: the parser, the event decoder and the merge are tested directly.
 */
import type { SegmentDTO } from "./meetings";

/** One redis stream id (`<ms>-<seq>`), the not-yet-read marker `-`, or the tail marker `$`. */
const CURSOR_PART = /^(?:\d{1,20}-\d{1,20}|-|\$)$/;

/** A `Last-Event-ID` the producer itself could have minted: two or three `|`-joined parts, each a
 *  stream id, `-` or `$`. Anything else is not a cursor and is never forwarded. */
export function isLiveCursor(value: string | null | undefined): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  const parts = value.split("|");
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((p) => CURSOR_PART.test(p));
}

/** One dispatched SSE message: its `data` and the last-event-id in force when it was dispatched. */
export interface SseMessage {
  data: string;
  id: string | undefined;
}

/** An incremental `text/event-stream` parser (the WHATWG algorithm, for unnamed messages): feed it
 *  decoded text in whatever pieces the network delivers and it calls `onMessage` once per complete
 *  message. Comment lines (`: keepalive`) and empty messages dispatch nothing. */
export function createSseParser(onMessage: (msg: SseMessage) => void): { push(text: string): void } {
  let buffer = "";
  let data: string[] = [];
  let lastId: string | undefined;

  function line(raw: string) {
    if (raw === "") {
      if (data.length) onMessage({ data: data.join("\n"), id: lastId });
      data = [];
      return;
    }
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) lastId = value;
  }

  return {
    push(text: string) {
      buffer += text;
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buffer);
        if (!m) break;
        // A lone `\r` at the very end may be the first half of a `\r\n` still in flight.
        if (m[0] === "\r" && m.index === buffer.length - 1) break;
        line(buffer.slice(0, m.index));
        buffer = buffer.slice(m.index + m[0].length);
      }
    },
  };
}

/** A transcript segment as the stream carries it, already in the REST segment's own field names
 *  (`segment_id`, `start`, `completed`) so both sources merge as one list. The stream event names
 *  no `end`, so a streamed segment has none until the next REST read supplies it. */
export type LiveEvent =
  | { type: "transcript"; segment: SegmentDTO & { segment_id: string } }
  | { type: "retract"; segmentIds: string[] }
  | { type: "meeting-end" };

function finiteOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Decode one SSE `data` payload into the events this client renders, or `null` for anything else
 *  (another producer's event type, a malformed payload, a transcript event with no segment id —
 *  without an id it could neither be updated nor retracted, so it is not admitted). */
export function decodeLiveEvent(data: string): LiveEvent | null {
  let ev: unknown;
  try {
    ev = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof ev !== "object" || ev === null || Array.isArray(ev)) return null;
  const e = ev as Record<string, unknown>;
  if (e.type === "transcript") {
    if (typeof e.id !== "string" || e.id.length === 0) return null;
    return {
      type: "transcript",
      segment: {
        segment_id: e.id,
        speaker: typeof e.speaker === "string" ? e.speaker : null,
        text: typeof e.text === "string" ? e.text : "",
        start: finiteOrNull(e.t),
        end: null,
        completed: e.completed !== false,
      },
    };
  }
  if (e.type === "retract") {
    const ids = Array.isArray(e.segment_ids) ? e.segment_ids.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
    return ids.length ? { type: "retract", segmentIds: ids } : null;
  }
  if (e.type === "meeting-end") return { type: "meeting-end" };
  return null;
}

/** A streamed event tagged with its arrival order, so a REST snapshot can drop exactly the events
 *  it already reflects (see `pruneLiveOps`). */
export interface LiveOp {
  seq: number;
  event: Extract<LiveEvent, { type: "transcript" | "retract" }>;
}

/** The transcript shown: the REST snapshot with every streamed event since applied in arrival
 *  order. A segment already present (same `segment_id`) is replaced where it stands; a new one is
 *  appended after everything shown; a retracted one is removed. Nothing is re-sorted. */
export function applyLiveOps(base: readonly SegmentDTO[], ops: readonly LiveOp[]): SegmentDTO[] {
  if (ops.length === 0) return base as SegmentDTO[];
  let out = base.slice();
  const index = new Map<string, number>();
  out.forEach((s, i) => {
    if (s.segment_id) index.set(s.segment_id, i);
  });
  for (const { event } of ops) {
    if (event.type === "transcript") {
      const at = index.get(event.segment.segment_id);
      if (at !== undefined) out[at] = event.segment;
      else {
        index.set(event.segment.segment_id, out.length);
        out.push(event.segment);
      }
    } else {
      const drop = new Set(event.segmentIds);
      if (!out.some((s) => s.segment_id && drop.has(s.segment_id))) continue;
      out = out.filter((s) => !(s.segment_id && drop.has(s.segment_id)));
      index.clear();
      out.forEach((s, i) => {
        if (s.segment_id) index.set(s.segment_id, i);
      });
    }
  }
  return out;
}

/** After a REST snapshot lands: keep only the events that arrived AFTER that read was issued
 *  (`mark` = the last seq seen when it was). Older events are already in the snapshot — or were
 *  superseded by it, so re-applying them would put a stale draft back over a confirmed line. */
export function pruneLiveOps(ops: readonly LiveOp[], mark: number): LiveOp[] {
  return ops.filter((op) => op.seq > mark);
}
