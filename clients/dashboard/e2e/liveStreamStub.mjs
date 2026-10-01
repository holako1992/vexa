/** The stub gateway's live transcript feed — `GET /agent/meeting/stream`, faked to the real
 *  producer's shape so the dashboard is tested against what it will actually receive.
 *
 *  Three real components are mirrored, each only as far as the dashboard can observe it:
 *
 *   • meeting-api's collector (`collector/ingest.py`): a pushed segment is persisted (so the REST
 *     `GET /transcripts/by-id/<id>` read returns it, sorted by start, upserted by `segment_id`) AND
 *     appended to the row's transcript stream (`_to_native_wire`); a retract deletes and appends a
 *     `retract` marker; an end appends `session_end`.
 *   • agent-api's `meeting_stream` (`control_plane/api.py`): owner check on `meeting_id`,
 *     `session_uid` must be the row id or its native id; a fresh connect replays the last 80
 *     transcript entries then tails; a `Last-Event-ID` resumes after its transcript cursor with no
 *     replay; every message is `id: <transcript>|<output>|<processed>` + `data: <json>`; an idle
 *     feed pings every 15s; `session_end` becomes `meeting-end` and closes the feed.
 *   • the gateway's `_forward_stream` (`gateway/app.py`): ANY agent-api answer — including a
 *     403/501 refusal — reaches the client as `200 text/event-stream`, the refusal's JSON body
 *     relayed as the stream's only bytes.
 *
 *  Specs drive it through `/__control/live/*` (see `handleLiveControl`).
 */

const REPLAY = 80; // MEETING_STREAM_TRANSCRIPT_REPLAY
const PING_MS = 15_000;
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" };

let streams = new Map(); // meeting id (string) -> [{ id, payload }]
let persisted = new Map(); // meeting id (string) -> Map(segment_id -> segment)
let connections = new Set(); // { meetingId, res, last, timer }
let unavailable = null; // null | "refuse" | "absent"
let seq = 0;

function nextEntryId() {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

function compareIds(a, b) {
  const [am, as] = a.split("-").map(Number);
  const [bm, bs] = b.split("-").map(Number);
  return am - bm || as - bs;
}

export function resetLive() {
  for (const c of connections) {
    clearInterval(c.timer);
    c.res.destroy();
  }
  connections = new Set();
  streams = new Map();
  persisted = new Map();
  unavailable = null;
}

/** The REST view: the fixture's own segments plus every pushed one still persisted, by start. */
export function withLiveSegments(meetingId, fixtureSegments) {
  const extra = persisted.get(String(meetingId));
  if (!extra || extra.size === 0) return fixtureSegments;
  return [...fixtureSegments, ...extra.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

function cursor(c) {
  return `${c.last}|$|0-0`;
}

function write(c, event) {
  c.res.write(`id: ${cursor(c)}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** One stream entry → the SSE events agent-api emits for it. Returns false on session_end. */
function emitEntry(c, entry) {
  const p = entry.payload;
  if (p.type === "session_end") {
    c.last = "-";
    write(c, { type: "meeting-end" });
    clearInterval(c.timer);
    connections.delete(c);
    c.res.end();
    return false;
  }
  c.last = entry.id;
  if (p.type === "retract") {
    if (p.segment_ids?.length) write(c, { type: "retract", segment_ids: p.segment_ids });
    return true;
  }
  for (const seg of p.segments ?? []) {
    write(c, {
      type: "transcript", speaker: seg.speaker, text: seg.text, t: seg.start,
      tsMs: seg.abs_start_ms, completed: seg.completed ?? true, id: seg.segment_id,
    });
  }
  return true;
}

function append(meetingId, payload) {
  const key = String(meetingId);
  const entry = { id: nextEntryId(), payload };
  if (!streams.has(key)) streams.set(key, []);
  streams.get(key).push(entry);
  for (const c of [...connections]) {
    if (c.meetingId === key) emitEntry(c, entry);
  }
}

/** `GET /agent/meeting/stream` on the stub gateway. `meetings` is the stub's current rows. */
export function handleLiveStream(req, res, url, meetings) {
  if (!req.headers["x-api-key"]) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "Missing API key" }));
    return;
  }
  if (unavailable === "absent") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "Not Found" }));
    return;
  }
  const meetingId = url.searchParams.get("meeting_id") || "";
  const sessionUid = url.searchParams.get("session_uid") || "";
  // From here on the gateway has already committed to 200 text/event-stream.
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();
  const refuse = (detail) => res.end(JSON.stringify({ detail }));
  if (unavailable === "refuse") return refuse("redis not wired");
  const row = /^\d+$/.test(meetingId) ? meetings.find((m) => String(m.id) === meetingId) : undefined;
  if (!row) return refuse("not authorized for this meeting");
  if (sessionUid !== String(row.native_meeting_id ?? "") && sessionUid !== meetingId) {
    return refuse("session_uid does not match this meeting");
  }

  const entries = streams.get(meetingId) ?? [];
  const lastEventId = req.headers["last-event-id"];
  const parts = typeof lastEventId === "string" && lastEventId.includes("|") ? lastEventId.split("|") : null;
  const resumeT = parts && parts[0] && parts[0] !== "-" ? parts[0] : null;
  const c = { meetingId, res, last: resumeT ?? "$", timer: undefined };
  connections.add(c);
  req.on("close", () => {
    clearInterval(c.timer);
    connections.delete(c);
  });

  const backlog = resumeT === null
    ? entries.slice(-REPLAY)
    : resumeT === "$" ? [] : entries.filter((e) => compareIds(e.id, resumeT) > 0);
  for (const e of backlog) {
    if (!emitEntry(c, e)) return;
  }
  c.timer = setInterval(() => write(c, { type: "ping" }), PING_MS);
}

/** `/__control/live/*` — the remote control specs use. Returns true when it answered. */
export async function handleLiveControl(url, req, res, readJsonBody, sendJson) {
  if (!url.pathname.startsWith("/__control/live/")) return false;
  const action = url.pathname.slice("/__control/live/".length);
  if (action === "connections") {
    sendJson(res, 200, { open: [...connections].map((c) => c.meetingId) });
    return true;
  }
  const body = await readJsonBody(req);
  const key = String(body.meetingId ?? "");
  if (action === "push") {
    // The collector: persist every segment, then append each non-empty one to the stream.
    if (!persisted.has(key)) persisted.set(key, new Map());
    for (const seg of body.segments ?? []) {
      const stored = { completed: true, end: seg.start, ...seg };
      persisted.get(key).set(stored.segment_id, stored);
      if (!(stored.text || "").trim()) continue;
      const start = Math.round(Number(stored.start || 0) * 10) / 10;
      append(key, {
        type: "transcription", session_uid: key, meeting_id: key,
        segments: [{
          speaker: stored.speaker || "Speaker", text: stored.text.trim(), start,
          end: Math.max(start, Math.round(Number(stored.end || 0) * 10) / 10),
          abs_start_ms: Math.round(start * 1000), completed: !!stored.completed,
          language: "en", segment_id: stored.segment_id,
        }],
      });
    }
  } else if (action === "retract") {
    const ids = body.segmentIds ?? [];
    for (const id of ids) persisted.get(key)?.delete(id);
    append(key, { type: "retract", segment_ids: ids });
  } else if (action === "end") {
    append(key, { type: "session_end", uid: key });
  } else if (action === "drop") {
    for (const c of [...connections]) {
      if (c.meetingId !== key) continue;
      clearInterval(c.timer);
      connections.delete(c);
      c.res.destroy();
    }
  } else if (action === "unavailable") {
    unavailable = body.mode ?? null;
  } else {
    return false;
  }
  sendJson(res, 200, { ok: true });
  return true;
}
