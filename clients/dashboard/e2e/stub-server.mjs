#!/usr/bin/env node
/** The e2e stub backend — the dashboard's ONLY two upstreams, faked.
 *
 *  Plain `node:http`, zero dependencies: the fixtures are the point, not a framework. It runs
 *  TWO listeners in one process:
 *
 *    - the GATEWAY (`GATEWAY_PORT`) — every path `src/lib/upstream.ts` will ever forward to, plus
 *      the write paths (`resolveWriteUpstream`). Anything else (e.g. `/recordings`, `/agent/chat`)
 *      still gets a response here (404), but the point of spec 07 is that the dashboard's OWN
 *      allowlist never lets such a request reach this process at all — if this stub's request
 *      log ever shows one of those paths, the dashboard's allowlist has a hole.
 *    - admin-api (`ADMIN_PORT`) — find-or-create, token mint/list/revoke, and the internal
 *      identity oracle (`lib/adminApi.ts`).
 *
 *  Every request that lands on either listener is appended to that listener's own in-memory log
 *  (never cleared except by `/__control/reset`), so a spec can assert not just "the UI showed the
 *  right thing" but "here is the exact upstream call, with these headers, and nothing else."
 *
 *  `/__control/*` is not gateway or admin-api surface — it is this harness's own remote control,
 *  used by specs' `beforeEach` to reset state and to force a failure response for one path.
 */
import { createServer } from "node:http";
import {
  ADMIN_API_KEY,
  ADMIN_PORT,
  GATEWAY_PORT,
  INTERNAL_API_SECRET,
} from "./ports.mjs";
import { freshCalendars, freshMeetings, transcriptFor, JITSI_HOSTS } from "./fixtures.mjs";

// ── shared mutable world, reset between specs ───────────────────────────────────────────────

let meetings = freshMeetings();
let calendars = freshCalendars();
let nextCalendarId = 1;
const bots = []; // every POST /bots body, in arrival order
const gatewayLog = [];
const adminLog = [];
/** Forced response overrides, keyed by a short name a spec asks for. Cleared on reset. */
let force = { meetings: null, meetingDetail: null };

let users = new Map(); // email -> { id, email, name }
let nextUserId = 1;
const tokens = new Map(); // token string -> { id, userId }
let nextTokenId = 1;

function resetAll() {
  meetings = freshMeetings();
  calendars = freshCalendars();
  nextCalendarId = 1;
  bots.length = 0;
  gatewayLog.length = 0;
  adminLog.length = 0;
  force = { meetings: null, meetingDetail: null };
  users = new Map();
  nextUserId = 1;
  tokens.clear();
  nextTokenId = 1;
}

// ── tiny helpers ─────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  if (body === null || status === 204) {
    res.writeHead(status, { "Content-Length": 0 });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function logRequest(log, req) {
  log.push({
    method: req.method,
    url: req.url,
    headers: { ...req.headers },
    at: Date.now(),
  });
}

// ── the gateway ──────────────────────────────────────────────────────────────────────────────

async function handleGateway(req, res) {
  const url = new URL(req.url, "http://stub");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/__control/health") return sendJson(res, 200, { ok: true });
  if (url.pathname === "/__control/reset" && req.method === "POST") { resetAll(); return sendJson(res, 200, { ok: true }); }
  if (url.pathname === "/__control/requests") return sendJson(res, 200, gatewayLog);
  if (url.pathname === "/__control/bots") return sendJson(res, 200, bots);
  if (url.pathname === "/__control/force" && req.method === "POST") {
    const body = await readJsonBody(req);
    force = { ...force, ...body };
    return sendJson(res, 200, { ok: true, force });
  }

  logRequest(gatewayLog, req);

  // GET /meetings
  if (req.method === "GET" && parts.length === 1 && parts[0] === "meetings") {
    if (force.meetings) return sendJson(res, force.meetings, { error: "forced_failure" });
    return sendJson(res, 200, { meetings });
  }

  // GET /meetings/<id>
  if (req.method === "GET" && parts.length === 2 && parts[0] === "meetings") {
    if (force.meetingDetail) return sendJson(res, force.meetingDetail, { error: "forced_failure" });
    const row = meetings.find((m) => String(m.id) === parts[1]);
    if (!row) return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 200, row);
  }

  // GET /transcripts/by-id/<id>
  if (req.method === "GET" && parts.length === 3 && parts[0] === "transcripts" && parts[1] === "by-id") {
    return sendJson(res, 200, { segments: transcriptFor(parts[2]) });
  }

  // GET /meeting/jitsi-hosts
  if (req.method === "GET" && parts.length === 2 && parts[0] === "meeting" && parts[1] === "jitsi-hosts") {
    return sendJson(res, 200, { hosts: JITSI_HOSTS });
  }

  // GET /user/calendars
  if (req.method === "GET" && parts.length === 2 && parts[0] === "user" && parts[1] === "calendars") {
    return sendJson(res, 200, { calendars });
  }

  // POST /bots
  if (req.method === "POST" && parts.length === 1 && parts[0] === "bots") {
    const body = await readJsonBody(req);
    bots.push(body);
    return sendJson(res, 200, { id: 900 + bots.length, status: "requested", ...body });
  }

  // POST /user/calendars
  if (req.method === "POST" && parts.length === 2 && parts[0] === "user" && parts[1] === "calendars") {
    const body = await readJsonBody(req);
    const cal = {
      id: String(nextCalendarId++),
      name: body.name || "Calendar",
      ics_url_set: !!body.ics_url,
      ics_url_masked: body.ics_url ? `***${String(body.ics_url).slice(-8)}` : null,
      auto_join: !!body.auto_join,
      bot_name: null,
      enabled: true,
    };
    calendars.push(cal);
    return sendJson(res, 200, cal);
  }

  // POST /user/calendars/<id>/sync
  if (req.method === "POST" && parts.length === 4 && parts[0] === "user" && parts[1] === "calendars" && parts[3] === "sync") {
    const cal = calendars.find((c) => c.id === parts[2]);
    if (!cal) return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 200, { synced: true, imported: 0 });
  }

  // PATCH /user/calendars/<id>
  if (req.method === "PATCH" && parts.length === 3 && parts[0] === "user" && parts[1] === "calendars") {
    const cal = calendars.find((c) => c.id === parts[2]);
    if (!cal) return sendJson(res, 404, { error: "not_found" });
    const body = await readJsonBody(req);
    Object.assign(cal, body);
    return sendJson(res, 200, cal);
  }

  // DELETE /user/calendars/<id>
  if (req.method === "DELETE" && parts.length === 3 && parts[0] === "user" && parts[1] === "calendars") {
    const before = calendars.length;
    calendars = calendars.filter((c) => c.id !== parts[2]);
    if (calendars.length === before) return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 204, null);
  }

  // Anything else — including the paths the dashboard's own allowlist must never forward
  // (e.g. /recordings, /agent/chat). If a spec sees THIS response in its own network log, the
  // dashboard proxy forwarded a request its allowlist should have refused with a 404 of its own.
  return sendJson(res, 404, { error: "not_found", note: "stub: no such gateway route" });
}

// ── admin-api ────────────────────────────────────────────────────────────────────────────────

function checkAdminKey(req, res) {
  if (req.headers["x-admin-api-key"] !== ADMIN_API_KEY) {
    sendJson(res, 401, { error: "bad admin key" });
    return false;
  }
  return true;
}

async function handleAdmin(req, res) {
  const url = new URL(req.url, "http://stub");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/__control/health") return sendJson(res, 200, { ok: true });
  if (url.pathname === "/__control/requests") return sendJson(res, 200, adminLog);

  // The internal oracle uses a different header (X-Internal-Secret), checked per-route below.
  if (url.pathname !== "/internal/validate" && !checkAdminKey(req, res)) return;

  logRequest(adminLog, req);

  // GET /admin/users/email/<email>
  if (req.method === "GET" && parts.length === 4 && parts[0] === "admin" && parts[1] === "users" && parts[2] === "email") {
    const email = decodeURIComponent(parts[3]);
    const user = users.get(email);
    if (!user) return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 200, user);
  }

  // POST /admin/users
  if (req.method === "POST" && parts.length === 2 && parts[0] === "admin" && parts[1] === "users") {
    const body = await readJsonBody(req);
    const email = body.email;
    let user = users.get(email);
    if (!user) {
      user = { id: nextUserId++, email, name: null };
      users.set(email, user);
    }
    return sendJson(res, 200, user);
  }

  // GET /admin/users/<id>/tokens
  if (req.method === "GET" && parts.length === 4 && parts[0] === "admin" && parts[1] === "users" && parts[3] === "tokens") {
    const userId = Number(parts[2]);
    const mine = [...tokens.entries()]
      .filter(([, t]) => t.userId === userId)
      .map(([, t]) => ({ id: t.id, name: t.name, created_at: t.createdAt }));
    return sendJson(res, 200, mine);
  }

  // POST /admin/users/<id>/tokens?scopes=...&name=...
  if (req.method === "POST" && parts.length === 4 && parts[0] === "admin" && parts[1] === "users" && parts[3] === "tokens") {
    const userId = Number(parts[2]);
    const name = url.searchParams.get("name") || "dashboard-login";
    const id = nextTokenId++;
    const value = `e2e-token-${userId}-${id}`;
    tokens.set(value, { id, userId, name, createdAt: new Date().toISOString() });
    return sendJson(res, 200, { id, name, created_at: new Date().toISOString(), token: value });
  }

  // DELETE /admin/tokens/<id>
  if (req.method === "DELETE" && parts.length === 3 && parts[0] === "admin" && parts[1] === "tokens") {
    const id = Number(parts[2]);
    for (const [value, t] of tokens) if (t.id === id) tokens.delete(value);
    return sendJson(res, 204, null);
  }

  // POST /internal/validate — the identity oracle. X-Internal-Secret, not the admin key.
  if (req.method === "POST" && url.pathname === "/internal/validate") {
    if (req.headers["x-internal-secret"] !== INTERNAL_API_SECRET) return sendJson(res, 401, { error: "bad secret" });
    logRequest(adminLog, req);
    const body = await readJsonBody(req);
    const entry = tokens.get(body.token);
    if (!entry) return sendJson(res, 401, { error: "not_authenticated" });
    const user = [...users.values()].find((u) => u.id === entry.userId);
    if (!user) return sendJson(res, 401, { error: "not_authenticated" });
    return sendJson(res, 200, { user_id: user.id, email: user.email });
  }

  return sendJson(res, 404, { error: "not_found", note: "stub: no such admin-api route" });
}

// ── boot ─────────────────────────────────────────────────────────────────────────────────────

/** Serve one request, and answer 500 rather than DYING when a handler rejects.
 *
 *  These handlers are async, so `void handle(req, res)` floats the promise: under Node 22 an
 *  unhandled rejection terminates the process. One bad request would take the stub down and every
 *  spec after it would fail with ECONNREFUSED — a harness that reports a single handler bug as
 *  eight unrelated failures, with the real cause off-screen. It is caught per request so one bad
 *  response stays one bad response. */
function serve(handler, label) {
  return createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error(`[stub:${label}] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: "stub_handler_failed", detail: String(err) });
      else res.destroy();
    });
  });
}

serve(handleGateway, "gateway").listen(GATEWAY_PORT, "127.0.0.1", () => {
  console.log(`[stub] gateway listening on ${GATEWAY_PORT}`);
});
serve(handleAdmin, "admin").listen(ADMIN_PORT, "127.0.0.1", () => {
  console.log(`[stub] admin-api listening on ${ADMIN_PORT}`);
});
