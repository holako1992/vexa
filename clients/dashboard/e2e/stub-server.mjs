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
import {
  freshCalendars,
  freshMeetings,
  transcriptFor,
  summaryFor,
  participantsFor,
  searchTranscripts,
  JITSI_HOSTS,
  freeEntitlements,
  QUOTA_EXCEEDED_BODY,
  E2E_GOOGLE_EMAIL,
  E2E_MICROSOFT_EMAIL,
} from "./fixtures.mjs";

const RUNNING_STATUSES = new Set(["requested", "joining", "awaiting_admission", "needs_help", "active", "stopping"]);
const SUPPORTED_STOP_PLATFORMS = new Set(["google_meet", "teams", "zoom", "jitsi"]);

// ── shared mutable world, reset between specs ───────────────────────────────────────────────

let meetings = freshMeetings();
let calendars = freshCalendars();
let nextCalendarId = 1;
const bots = []; // every POST /bots body, in arrival order
const gatewayLog = [];
const adminLog = [];
/** Forced response overrides, keyed by a short name a spec asks for. Cleared on reset.
 *  `botsQuota: true` makes `POST /bots` answer DB-72's unwrapped 402 `quota_exceeded` body
 *  instead of dispatching — spec 14's paywall proof. */
let force = {
  meetings: null, meetingDetail: null, botsQuota: false, search: null,
  googleExchange: null, microsoftExchange: null,
};
/** DB-31 — the state tokens `GET /user/calendars/google/authorize` has issued, and which of
 *  those have already been consumed by an exchange. Mirrors just enough of the core's real
 *  behaviour (`google_oauth.sign_state`/`verify_state`) for the e2e specs: an unknown or
 *  already-used state is refused with the same `"invalid state: …"` shape the real 400 carries,
 *  without reimplementing HMAC signing in a test double that exists to prove the DASHBOARD's
 *  handling of that refusal, not the core's crypto. */
let issuedGoogleStates = new Set();
let usedGoogleStates = new Set();
/** DB-32/DB-33 — the Microsoft sibling of the two sets just above (`microsoft_oauth.sign_state`/
 *  `verify_state`), kept in its OWN sets so a state minted for one provider's flow is never
 *  mistaken for a replay of the other's — same rule `main.py`'s `_consume_oauth_nonce` applies
 *  with its per-provider `field`. */
let issuedMicrosoftStates = new Set();
let usedMicrosoftStates = new Set();
/** DB-34 — each connected calendar's last sync stamp, keyed by calendar id, in EXACTLY the shape
 *  `GET /user/calendars/<id>/sync` answers (`{last_sync, last_error, counts}` —
 *  `meeting_api/calendar_sync/runner.py`'s `run_user_sync`). No entry means "never synced yet",
 *  which the route answers as `{}`, same as the real one before any sync has run. */
let syncStamps = new Map();
/** `GET /user/entitlements`'s current answer (DB-74/DB-75) — swapped per spec via
 *  `/__control/entitlements` (`helpers.ts`'s `setEntitlements`), reset to the free-plan default
 *  on every `/__control/reset`. */
let entitlements = freeEntitlements();
/** Mirrors `users.data.stripe_customer_id` on the real core (DB-74b): `null` until the account's
 *  first `POST /billing/checkout`, which is exactly when `POST /billing/portal` starts answering
 *  a session instead of 409. `/__control/billingCustomer` lets a spec set it directly, to prove
 *  the Manage button's success path without first driving a real checkout. */
let stripeCustomerId = null;
/** While non-null, every `GET /transcripts/search` waits on this gate before answering, so a spec
 *  can observe the in-flight state for as long as it needs. `/__control/searchHold` opens it,
 *  `/__control/searchRelease` lets every waiting request through. */
let searchHold = null;

function releaseSearchHold() {
  if (searchHold) searchHold.release();
  searchHold = null;
}

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
  force = {
    meetings: null, meetingDetail: null, botsQuota: false, search: null,
    googleExchange: null, microsoftExchange: null,
  };
  issuedGoogleStates = new Set();
  usedGoogleStates = new Set();
  issuedMicrosoftStates = new Set();
  usedMicrosoftStates = new Set();
  syncStamps = new Map();
  entitlements = freeEntitlements();
  stripeCustomerId = null;
  releaseSearchHold();
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
  const entry = {
    method: req.method,
    url: req.url,
    headers: { ...req.headers },
    at: Date.now(),
  };
  log.push(entry);
  return entry;
}

/** Read a request's JSON body AND record it on its own already-logged entry — so a spec can
 *  assert not just "the dashboard called this route" (`gatewayRequests()`) but the exact payload
 *  it sent (`entry.body`), e.g. DB-33's Join / Don't join toggle asserting `{auto_join: false}`
 *  actually reached the stub. `entry` is whatever `logRequest` returned for THIS request — every
 *  write handler in `handleGateway` that used to call bare `readJsonBody(req)` calls this instead,
 *  so the one entry already in `gatewayLog` gains a `body` field rather than a second log write. */
async function readAndLogBody(req, entry) {
  const body = await readJsonBody(req);
  if (entry) entry.body = body;
  return body;
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
  if (url.pathname === "/__control/searchHold" && req.method === "POST") {
    if (!searchHold) {
      let release;
      const gate = new Promise((r) => { release = r; });
      searchHold = { gate, release };
    }
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/__control/searchRelease" && req.method === "POST") {
    releaseSearchHold();
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/__control/entitlements" && req.method === "POST") {
    entitlements = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, entitlements });
  }
  // DB-74b: set/clear whether this account has a Stripe customer on file — see `stripeCustomerId`
  // above. `helpers.ts`'s `setStripeCustomer(request, present)`.
  if (url.pathname === "/__control/billingCustomer" && req.method === "POST") {
    const body = await readJsonBody(req);
    stripeCustomerId = body.present ? "cus_e2e_test" : null;
    return sendJson(res, 200, { ok: true, stripeCustomerId });
  }
  // DB-48's "a live row on a later page stays visible" spec: flip one fixture meeting's status
  // without going through a real bot lifecycle, so the spec can prove the POLL's re-fetch window
  // rule rather than the bot-spawn path (already covered elsewhere).
  // DB-31: seed one raw calendar connection directly (e.g. a pre-existing Google connection with
  // `reconnect_needed: true`) — a shortcut around driving a real connect first, the same role
  // `/__control/setMeetingStatus` plays for meetings below. An id is minted if the caller didn't
  // give one.
  if (url.pathname === "/__control/seedCalendar" && req.method === "POST") {
    const body = await readJsonBody(req);
    const cal = { id: String(nextCalendarId++), ...body };
    calendars.push(cal);
    return sendJson(res, 200, { ok: true, calendar: cal });
  }
  // DB-34: seed a connection's sync stamp directly — the health page's "failed feed" and "N
  // events touched" specs need a specific `{last_sync, last_error, counts}` without driving a
  // real sync first. `calendarId` names an EXISTING connection (seed it with `seedCalendar`
  // first, or use the fixture's own id).
  if (url.pathname === "/__control/seedSyncStamp" && req.method === "POST") {
    const body = await readJsonBody(req);
    syncStamps.set(String(body.calendarId), body.stamp ?? {});
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === "/__control/setMeetingStatus" && req.method === "POST") {
    const body = await readJsonBody(req);
    const row = meetings.find((m) => String(m.id) === String(body.id));
    if (!row) return sendJson(res, 404, { error: "not_found" });
    row.status = body.status;
    if (body.status === "active") row.end_time = null;
    return sendJson(res, 200, { ok: true });
  }

  const logEntry = logRequest(gatewayLog, req);

  // GET /meetings — DB-48: honours `limit`/`offset` and reports `has_more`, exactly like
  // meeting-api's own handler (`meeting_api/collector/app.py`'s `get_meetings`, which forwards
  // the store's own `has_more` return value rather than discarding it).
  if (req.method === "GET" && parts.length === 1 && parts[0] === "meetings") {
    if (force.meetings) return sendJson(res, force.meetings, { error: "forced_failure" });
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : meetings.length;
    const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
    const effectiveLimit = Number.isFinite(limit) ? limit : meetings.length;
    const page = meetings.slice(offset, offset + effectiveLimit);
    const hasMore = offset + page.length < meetings.length;
    return sendJson(res, 200, { meetings: page, has_more: hasMore });
  }

  // GET /transcripts/search?q=... — DB-44. Checked before the generic 3-segment transcripts
  // branch, same ordering rule the real route uses ("search" is not a platform). A spec that
  // needs to see the in-flight state holds the answer with `/__control/searchHold`.
  if (req.method === "GET" && parts.length === 2 && parts[0] === "transcripts" && parts[1] === "search") {
    if (searchHold) await searchHold.gate;
    if (force.search) return sendJson(res, force.search, { error: "forced_failure" });
    const q = url.searchParams.get("q") || "";
    if (!q.trim()) return sendJson(res, 422, { detail: "'q' must not be blank" });
    const limit = url.searchParams.get("limit") ?? undefined;
    const offset = url.searchParams.get("offset") ?? undefined;
    const hits = searchTranscripts(meetings, q, { limit, offset });
    return sendJson(res, 200, { query: q, hits, count: hits.length });
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

  // GET /agent/workspace/file?path=meetings/<id>/summary.md — DB-60's summary door. The dashboard
  // composes this path itself; only a numeric id ever reaches it (upstream.test.ts proves that),
  // so this stub only ever needs to answer the one shape.
  if (req.method === "GET" && parts.length === 3 && parts[0] === "agent" && parts[1] === "workspace" && parts[2] === "file") {
    const path = url.searchParams.get("path") || "";
    const m = /^meetings\/(\d+)\/summary\.md$/.exec(path);
    const content = m ? summaryFor(m[1]) : null;
    if (content == null) return sendJson(res, 404, { detail: "not found" });
    return sendJson(res, 200, { path, content });
  }

  // GET /bots/status — the caller's currently running bots (DB-41).
  if (req.method === "GET" && parts.length === 2 && parts[0] === "bots" && parts[1] === "status") {
    const running = meetings.filter((m) => RUNNING_STATUSES.has(m.status));
    return sendJson(res, 200, { running, running_bots: running, count: running.length });
  }

  // GET /user/entitlements — the resolved plan/limits/usage (DB-70/DB-74/DB-75).
  if (req.method === "GET" && parts.length === 2 && parts[0] === "user" && parts[1] === "entitlements") {
    return sendJson(res, 200, entitlements);
  }

  // DELETE /bots/<platform>/<native> — Stop recording (DB-41). Mirrors meeting-api's own shape
  // closely enough for the dashboard's spec: an unsupported platform is 422, an unknown/already-
  // stopped pair is 404, otherwise the row moves to `completed` with `stop_requested: true`.
  if (req.method === "DELETE" && parts.length === 3 && parts[0] === "bots") {
    const [, platform, native] = parts;
    if (!SUPPORTED_STOP_PLATFORMS.has(platform)) {
      return sendJson(res, 422, { detail: `unsupported platform '${platform}'` });
    }
    const row = meetings.find(
      (m) => m.platform === platform && m.native_meeting_id === native && RUNNING_STATUSES.has(m.status),
    );
    if (!row) return sendJson(res, 404, { detail: "No active meeting for this bot" });
    row.status = "completed";
    row.end_time = row.end_time || new Date().toISOString();
    row.data = { ...(row.data || {}), stop_requested: true };
    return sendJson(res, 200, {
      status: "stopping", meeting_id: row.id, native_meeting_id: native, also_stopped: [], cancelled: [],
    });
  }

  // GET /meetings/<platform>/<native>/participants — DB-42.
  if (req.method === "GET" && parts.length === 4 && parts[0] === "meetings" && parts[3] === "participants") {
    const [, platform, native] = parts;
    const found = participantsFor(platform, native);
    if (!found) return sendJson(res, 404, { detail: `Meeting not found for platform ${platform} and ID ${native}` });
    const participants = [
      ...(found.invited || []).map((p) => ({
        name: p.name || null, email: p.email || null, source: "invite",
        ...(p.partstat ? { response_status: p.partstat } : {}),
      })),
      ...(found.speakers || []).map((name) => ({ name, email: null, source: "speaker" })),
    ];
    return sendJson(res, 200, {
      meeting_id: null, platform, native_meeting_id: native, participants,
      sources: [...new Set(participants.map((p) => p.source))].sort(),
      observed_roster: "not_recorded",
    });
  }

  // POST /meetings/<id>/annotate — inline rename (DB-42): {title} merges onto the row's own data.
  if (req.method === "POST" && parts.length === 3 && parts[0] === "meetings" && parts[2] === "annotate") {
    const row = meetings.find((m) => String(m.id) === parts[1]);
    if (!row) return sendJson(res, 404, { detail: "Meeting not found" });
    const body = await readAndLogBody(req, logEntry);
    if (typeof body.title === "string") row.data = { ...(row.data || {}), title: body.title };
    return sendJson(res, 200, row);
  }

  // PATCH /meetings/<id> {auto_join} — DB-33's Upcoming page's Join / Don't join override. The
  // dashboard's own allowlist (`upstream.ts`'s `isAutoJoinBody`) only ever forwards this exact
  // shape, so the stub only needs to answer it. Mirrors `_apply_meeting_patch`
  // (`meeting_api/collector/app.py`): only the field actually sent is written; a stale
  // `auto_join_error` from a past attempt is untouched here too — the producer clears it only
  // from the auto-join sweep itself, on a SUCCESSFUL dispatch, never from this route.
  if (req.method === "PATCH" && parts.length === 2 && parts[0] === "meetings") {
    const row = meetings.find((m) => String(m.id) === parts[1]);
    if (!row) return sendJson(res, 404, { detail: "Meeting not found" });
    const body = await readAndLogBody(req, logEntry);
    if (typeof body.auto_join === "boolean") {
      row.data = { ...(row.data || {}), auto_join: body.auto_join };
    }
    return sendJson(res, 200, row);
  }

  // DELETE /meetings/<id> — delete a planned row outright, or wipe a completed one's transcript
  // and recordings while the row itself stays (meeting-api's own two branches; DB-42's confirm
  // text names both without knowing in advance which one a given meeting will take).
  if (req.method === "DELETE" && parts.length === 2 && parts[0] === "meetings") {
    const idx = meetings.findIndex((m) => String(m.id) === parts[1]);
    if (idx === -1) return sendJson(res, 404, { detail: "Meeting not found" });
    const row = meetings[idx];
    if (row.status === "scheduled" || row.status === "idle") {
      meetings.splice(idx, 1);
      return sendJson(res, 204, null);
    }
    row.data = { ...(row.data || {}), recordings: undefined, artifact_deletion: { state: "completed" } };
    return sendJson(res, 200, { status: "deleted", id: row.id, platform: row.platform, native_meeting_id: row.native_meeting_id, deleted: "completed_meeting_artifacts" });
  }

  // GET /user/calendars
  if (req.method === "GET" && parts.length === 2 && parts[0] === "user" && parts[1] === "calendars") {
    return sendJson(res, 200, { calendars });
  }

  // GET /user/calendars/google/authorize — DB-31. Mints a state, records it as issued (never
  // signs it — see `issuedGoogleStates`'s comment above), and hands back a REAL
  // accounts.google.com URL carrying it, exactly like `google_oauth.build_authorize_url`, so the
  // dashboard's own `isTrustedGoogleAuthorizeRedirect` check has something real to accept.
  if (
    req.method === "GET" && parts.length === 4 && parts[0] === "user" && parts[1] === "calendars" &&
    parts[2] === "google" && parts[3] === "authorize"
  ) {
    // Two dot-separated segments, matching the SHAPE `google_oauth.sign_state` always produces
    // (a base64url body, a dot, a base64url signature) — the dashboard's own allowlist
    // (`lib/upstream.ts`'s `isGoogleExchangeBody`) checks exactly this shape before ever
    // forwarding an exchange body, so the stub must issue a state that shape describes, even
    // though (unlike the real core) it signs nothing.
    const seg1 = `e2estate${issuedGoogleStates.size + 1}${Math.random().toString(36).slice(2, 10)}`;
    const seg2 = Math.random().toString(36).slice(2, 12);
    const state = `${seg1}.${seg2}`;
    issuedGoogleStates.add(state);
    const authorize_url =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: "e2e-test-client",
        redirect_uri: "http://127.0.0.1:3100/calendar/google/callback",
        response_type: "code",
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
    return sendJson(res, 200, { authorize_url, state });
  }

  // POST /user/calendars/google/exchange {code, state} — DB-31's callback page. `code` is never
  // inspected (the stub has no real Google token endpoint to call) — only `state`'s issued/used
  // bookkeeping and `force.googleExchange` decide the answer, which is exactly the seam the
  // dashboard's own specs need: THIS client's handling of a state refusal or an upstream failure,
  // not Google's token endpoint.
  if (
    req.method === "POST" && parts.length === 4 && parts[0] === "user" && parts[1] === "calendars" &&
    parts[2] === "google" && parts[3] === "exchange"
  ) {
    const body = await readAndLogBody(req, logEntry);
    if (force.googleExchange) {
      return sendJson(res, force.googleExchange, {
        detail: "Google rejected the authorization code: invalid_grant",
      });
    }
    const state = body.state;
    if (typeof state !== "string" || !issuedGoogleStates.has(state)) {
      return sendJson(res, 400, { detail: "invalid state: unknown, expired, or forged" });
    }
    if (usedGoogleStates.has(state)) {
      return sendJson(res, 409, { detail: "this authorization has already been used" });
    }
    usedGoogleStates.add(state);
    let cal = calendars.find((c) => c.kind === "google" && c.google_email === E2E_GOOGLE_EMAIL);
    if (cal) {
      cal.reconnect_needed = false;
    } else {
      cal = {
        id: String(nextCalendarId++),
        kind: "google",
        name: `Google — ${E2E_GOOGLE_EMAIL}`,
        google_email: E2E_GOOGLE_EMAIL,
        google_calendar_ids: ["primary"],
        reconnect_needed: false,
        auto_join: true,
        bot_name: "Vexa",
        enabled: true,
      };
      calendars.push(cal);
    }
    return sendJson(res, 201, cal);
  }

  // GET /user/calendars/microsoft/authorize — DB-32/DB-33's Microsoft sibling of the Google
  // authorize route above. Mints a state, records it as issued, and hands back a REAL
  // login.microsoftonline.com URL carrying it, so the dashboard's own
  // `isTrustedMicrosoftAuthorizeRedirect` check has something real to accept.
  if (
    req.method === "GET" && parts.length === 4 && parts[0] === "user" && parts[1] === "calendars" &&
    parts[2] === "microsoft" && parts[3] === "authorize"
  ) {
    const seg1 = `e2estate${issuedMicrosoftStates.size + 1}${Math.random().toString(36).slice(2, 10)}`;
    const seg2 = Math.random().toString(36).slice(2, 12);
    const state = `${seg1}.${seg2}`;
    issuedMicrosoftStates.add(state);
    const authorize_url =
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" +
      new URLSearchParams({
        client_id: "e2e-test-client",
        redirect_uri: "http://127.0.0.1:3100/calendar/microsoft/callback",
        response_type: "code",
        response_mode: "query",
        scope: "https://graph.microsoft.com/Calendars.Read offline_access",
        prompt: "consent",
        state,
      }).toString();
    return sendJson(res, 200, { authorize_url, state });
  }

  // POST /user/calendars/microsoft/exchange {code, state} — DB-32/DB-33's callback page. Same
  // rule as the Google exchange above: `code` is never inspected, only `state`'s issued/used
  // bookkeeping and `force.microsoftExchange` decide the answer.
  if (
    req.method === "POST" && parts.length === 4 && parts[0] === "user" && parts[1] === "calendars" &&
    parts[2] === "microsoft" && parts[3] === "exchange"
  ) {
    const body = await readAndLogBody(req, logEntry);
    if (force.microsoftExchange) {
      return sendJson(res, force.microsoftExchange, {
        detail: "Microsoft rejected the authorization code: invalid_grant",
      });
    }
    const state = body.state;
    if (typeof state !== "string" || !issuedMicrosoftStates.has(state)) {
      return sendJson(res, 400, { detail: "invalid state: unknown, expired, or forged" });
    }
    if (usedMicrosoftStates.has(state)) {
      return sendJson(res, 409, { detail: "this authorization has already been used" });
    }
    usedMicrosoftStates.add(state);
    let cal = calendars.find((c) => c.kind === "microsoft" && c.microsoft_email === E2E_MICROSOFT_EMAIL);
    if (cal) {
      cal.reconnect_needed = false;
    } else {
      cal = {
        id: String(nextCalendarId++),
        kind: "microsoft",
        name: `Microsoft — ${E2E_MICROSOFT_EMAIL}`,
        microsoft_email: E2E_MICROSOFT_EMAIL,
        microsoft_calendar_ids: ["primary"],
        reconnect_needed: false,
        auto_join: true,
        bot_name: "Vexa",
        enabled: true,
      };
      calendars.push(cal);
    }
    return sendJson(res, 201, cal);
  }

  // POST /bots
  if (req.method === "POST" && parts.length === 1 && parts[0] === "bots") {
    // DB-72/DB-75: `force.botsQuota` mirrors meeting-api's monthly-quota refusal — an unwrapped
    // 402, no `{"detail": ...}` envelope. The dashboard's paywall must branch on the `error`
    // field this body carries, never on the 402 status alone (see SendBotDialog.tsx).
    if (force.botsQuota) return sendJson(res, 402, QUOTA_EXCEEDED_BODY);
    const body = await readAndLogBody(req, logEntry);
    bots.push(body);
    return sendJson(res, 200, { id: 900 + bots.length, status: "requested", ...body });
  }

  // POST /billing/checkout {plan, interval} — DB-74b's Upgrade button. Mirrors
  // `create_billing_checkout` (`admin_api/app/main.py`) closely enough for the dashboard's own
  // spec: mints a Stripe customer on first use (idempotent after), and returns a Checkout Session
  // URL on the real `checkout.stripe.com` host — the dashboard's own `isTrustedBillingRedirect`
  // guard checks exactly this host, so the stub must answer a real one, not a fake test domain.
  if (req.method === "POST" && parts.length === 2 && parts[0] === "billing" && parts[1] === "checkout") {
    const body = await readAndLogBody(req, logEntry);
    if (!stripeCustomerId) stripeCustomerId = "cus_e2e_test";
    return sendJson(res, 200, {
      url: `https://checkout.stripe.com/c/pay/e2e_test_session#${body.plan}_${body.interval}`,
    });
  }

  // POST /billing/portal — DB-74b's Manage-subscription button. 409 with no body when there is no
  // Stripe customer yet, exactly like `create_billing_portal`'s `HTTPException(409, ...)`.
  if (req.method === "POST" && parts.length === 2 && parts[0] === "billing" && parts[1] === "portal") {
    if (!stripeCustomerId) {
      return sendJson(res, 409, { detail: "No Stripe customer on file yet — checkout (POST /billing/checkout) first" });
    }
    return sendJson(res, 200, { url: "https://billing.stripe.com/p/session/e2e_test_session" });
  }

  // POST /user/calendars
  if (req.method === "POST" && parts.length === 2 && parts[0] === "user" && parts[1] === "calendars") {
    const body = await readAndLogBody(req, logEntry);
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

  // GET /user/calendars/<id>/sync — DB-34's health read: the connection's last sync stamp, or
  // `{}` when it has never synced (same as the real route before any sweep/POST has run for it).
  if (req.method === "GET" && parts.length === 4 && parts[0] === "user" && parts[1] === "calendars" && parts[3] === "sync") {
    const cal = calendars.find((c) => c.id === parts[2]);
    if (!cal) return sendJson(res, 404, { error: "not_found" });
    return sendJson(res, 200, syncStamps.get(parts[2]) ?? {});
  }

  // POST /user/calendars/<id>/sync — "sync now" (DB-31's Calendar tab, DB-33's Upcoming page,
  // DB-34's health page all call this). Answers the SAME stamp shape the GET above reads back,
  // and stores it, so a spec can drive a real sync and then read its own result off the health
  // route — meeting-api's own `calendar_connection_sync_run` behaves identically.
  if (req.method === "POST" && parts.length === 4 && parts[0] === "user" && parts[1] === "calendars" && parts[3] === "sync") {
    const cal = calendars.find((c) => c.id === parts[2]);
    if (!cal) return sendJson(res, 404, { error: "not_found" });
    const stamp = {
      last_sync: new Date().toISOString(),
      last_error: null,
      counts: { created: 1, updated: 0, cancelled: 0 },
    };
    syncStamps.set(parts[2], stamp);
    return sendJson(res, 200, stamp);
  }

  // PATCH /user/calendars/<id>
  if (req.method === "PATCH" && parts.length === 3 && parts[0] === "user" && parts[1] === "calendars") {
    const cal = calendars.find((c) => c.id === parts[2]);
    if (!cal) return sendJson(res, 404, { error: "not_found" });
    const body = await readAndLogBody(req, logEntry);
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
