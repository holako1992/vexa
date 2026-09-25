/** The closed allowlist that defines the dashboard's entire backend surface.
 *
 *  The dashboard reads meetings and transcripts. That is the whole product, so that is the whole
 *  allowlist — `/api/vexa/<path>` resolves through `resolveUpstream()` and anything it does not
 *  recognise is a 404, not a forwarded request. An allowlist rather than a denylist because the
 *  gateway fronts far more than this client needs (bots, agent, workspace); a catch-all proxy
 *  would hand a browser every one of those edges under the user's key.
 *
 *  Pure and dependency-free so the table can be tested directly (src/lib/__tests__).
 */

/** A per-parameter shape check: `true` admits the raw string value, `false` drops it. Never a
 *  transform — filterQuery forwards the caller's own bytes for whatever it admits, it does not
 *  rewrite them. */
export type QueryValidator = (value: string) => boolean;

export interface UpstreamRoute {
  /** The gateway path this request maps to, with its segments already encoded. */
  path: string;
  /** The query parameters THIS route admits, each with its own shape check. Absent or empty means
   *  the route takes no query at all — see `filterQuery`'s header comment for why this is declared
   *  per route rather than once globally. */
  query?: Record<string, QueryValidator>;
}

/** Platform ids meeting-api accepts. A transcript path is only built for one of these — an
 *  arbitrary segment would let a caller shape the upstream URL. */
const PLATFORMS = new Set(["google_meet", "teams", "zoom", "jitsi"]);

/** One path segment with no separators — the shape every id below must have before it is
 *  interpolated into an upstream URL. */
const SAFE_SEGMENT = /^[^/?#\s]{1,256}$/;

/** A bounded, all-digits integer — the shape check every `limit`/`offset` value gets before it is
 *  forwarded. Rejects negative numbers, decimals, and anything with leading `+`/whitespace that
 *  `Number()` would otherwise coerce. */
function boundedInt(min: number, max: number): QueryValidator {
  return (v) => {
    if (!/^\d{1,10}$/.test(v)) return false;
    const n = Number(v);
    return n >= min && n <= max;
  };
}

/** `limit`/`offset` shapes, matching meeting-api's own `Query(..., ge=..., le=...)` bounds
 *  (`GET /meetings` and `GET /transcripts/search` both clamp `limit` to 1–100; `offset` has no
 *  upper bound at the producer, so this caps it generously rather than mirroring "no bound" —
 *  an unbounded digit string is still a denial-of-service-shaped input worth refusing). */
const LIMIT = boundedInt(1, 100);
const OFFSET = boundedInt(0, 1_000_000_000);

/** Paging params: the shape every list-like GET route in this file that wants them declares by
 *  spreading this object into its own `query`. Declared once so `limit`/`offset` mean the same
 *  bounds everywhere, never assembled into one allowlist consulted by every route regardless of
 *  whether that route's handler reads paging params at all (that was the bug: a single global
 *  `ALLOWED_QUERY` meant a new parameter added for one route silently rode along to every other
 *  one too — see `filterQuery`'s header comment). */
const PAGING_QUERY: Record<string, QueryValidator> = { limit: LIMIT, offset: OFFSET };

/** `q`'s shape: non-blank, and capped at the same 512 chars meeting-api's own
 *  `SEARCH_QUERY_MAX_CHARS` (`meeting_api/collector/app.py`) enforces server-side. An overlong `q`
 *  is DROPPED here, never truncated — truncating would silently change what the caller searched
 *  for (a different query, not a shorter one of the same query), and a dropped `q` reaches
 *  meeting-api as a missing required parameter, which is a clean 422 rather than a silently wrong
 *  search. */
const SEARCH_QUERY_MAX_CHARS = 512;
const isSearchText: QueryValidator = (v) => v.length >= 1 && v.length <= SEARCH_QUERY_MAX_CHARS;

/** `GET /transcripts/search`'s own query shape: `q` plus the same paging bounds every list route
 *  uses. Declared here, not merged into `PAGING_QUERY` itself, so `q` only ever reaches the one
 *  route that declares it — see the security note on `filterQuery` below. */
const SEARCH_QUERY: Record<string, QueryValidator> = { q: isSearchText, ...PAGING_QUERY };

/** Map a `/api/vexa/<...segments>` GET to its gateway path, or null to refuse.
 *
 *  Recognised:
 *    meetings                        → /meetings                      (the caller's meeting rows)
 *    meetings/<meetingId>            → /meetings/<meetingId>          (owner-scoped, row-keyed)
 *    transcripts/by-id/<meetingId>   → /transcripts/by-id/<meetingId> (owner-scoped, row-keyed)
 *    transcripts/<platform>/<native> → /transcripts/<platform>/<native>
 *    transcripts/search              → /transcripts/search            (DB-44, own `q` param)
 *
 *  Every one is a read. The dashboard issues no writes, so `resolveUpstream` is only ever
 *  consulted for GET and the route refuses every other method before it is called.
 */
export function resolveUpstream(segments: readonly string[]): UpstreamRoute | null {
  if (segments.length === 1 && segments[0] === "meetings") {
    // DB-48: the ONLY route a caller can page through today — meeting-api's `GET /meetings`
    // honours `limit`/`offset` (`meeting_api/collector/app.py`'s `get_meetings`) and nothing else
    // paging-shaped (no `cursor` param exists there); it returns no total and no `has_more`, which
    // is why `lib/meetings.ts`'s pagination infers "more may exist" from a full page rather than
    // trusting a signal the producer doesn't send.
    return { path: "/meetings", query: PAGING_QUERY };
  }

  // GET /transcripts/search?q=... — DB-44. Checked before the generic 3-segment transcripts
  // branch below since "search" would otherwise be read as a platform slug.
  if (segments.length === 2 && segments[0] === "transcripts" && segments[1] === "search") {
    return { path: "/transcripts/search", query: SEARCH_QUERY };
  }

  if (segments.length === 2 && segments[0] === "meetings") {
    // A meeting row id is numeric — the same shape the `transcripts/by-id/<id>` branch checks.
    const [, id] = segments as [string, string];
    if (!/^\d{1,20}$/.test(id)) return null;
    return { path: `/meetings/${encodeURIComponent(id)}` };
  }

  // meetings/<id>/summary — the ONE door onto the post-meeting note (DB-60, docs/docs/how-to/
  // post-meeting-report.mdx). The browser never sees a workspace path: this composes the fixed
  // upstream `/agent/workspace/file?path=meetings/<id>/summary.md` itself from the numeric id
  // alone, so nothing the caller sends can steer which workspace file gets read. The `?path=`
  // query lives IN the resolved path on purpose — `filterQuery` is for the generic allowlist's
  // paging params and must never touch this one (the route handler skips it whenever a resolved
  // path already carries a query string, so a caller's own `?path=...` is always dropped, never
  // merged).
  if (segments.length === 3 && segments[0] === "meetings" && segments[2] === "summary") {
    const [, id] = segments as [string, string, string];
    if (!/^\d{1,20}$/.test(id)) return null;
    return { path: `/agent/workspace/file?path=meetings/${id}/summary.md` };
  }

  // meetings/<platform>/<native>/participants — read-only roster (invite + speaker sources).
  if (segments.length === 4 && segments[0] === "meetings" && segments[3] === "participants") {
    const [, platform, native] = segments as [string, string, string, string];
    if (!PLATFORMS.has(platform)) return null;
    if (!SAFE_SEGMENT.test(native)) return null;
    return { path: `/meetings/${platform}/${encodeURIComponent(native)}/participants` };
  }

  const extra = resolveReadExtras(segments);
  if (extra) return extra;

  if (segments.length === 3 && segments[0] === "transcripts") {
    const [, a, b] = segments as [string, string, string];
    if (!SAFE_SEGMENT.test(b)) return null;
    if (a === "by-id") {
      // A meeting row id is numeric — narrower than SAFE_SEGMENT, so say so.
      if (!/^\d{1,20}$/.test(b)) return null;
      return { path: `/transcripts/by-id/${encodeURIComponent(b)}` };
    }
    if (PLATFORMS.has(a)) return { path: `/transcripts/${a}/${encodeURIComponent(b)}` };
    return null;
  }

  return null;
}

/** Recognised GET paths that are not read-only meeting/transcript data. Added alongside the
 *  existing three so they can be tested in the same table. */
function resolveReadExtras(segments: readonly string[]): UpstreamRoute | null {
  // GET /user/calendars — list connected calendars
  if (segments.length === 2 && segments[0] === "user" && segments[1] === "calendars") {
    return { path: "/user/calendars" };
  }
  // GET /meeting/jitsi-hosts — deployment's declared Jitsi hostnames (for the URL parser)
  if (segments.length === 2 && segments[0] === "meeting" && segments[1] === "jitsi-hosts") {
    return { path: "/meeting/jitsi-hosts" };
  }
  // GET /bots/status — the caller's currently-running bots (DB-41's status badge)
  if (segments.length === 2 && segments[0] === "bots" && segments[1] === "status") {
    return { path: "/bots/status" };
  }
  // GET /user/entitlements — the resolved plan, limits and usage (DB-74/DB-75's billing page and
  // the Send-Bot dialog's paywall copy). Read-only, owner-scoped by the gateway like every other
  // route here.
  if (segments.length === 2 && segments[0] === "user" && segments[1] === "entitlements") {
    return { path: "/user/entitlements" };
  }
  return null;
}

/** Safe calendar-id shape: printable, no path separators, bounded. */
const SAFE_CAL_ID = /^[^/?#\s]{1,128}$/;

/** Resolve a write (POST / PATCH / DELETE) request against the closed write-path allowlist.
 *  Only the three write surfaces the dashboard exposes are admitted; everything else is null. */
export function resolveWriteUpstream(method: string, segments: readonly string[]): UpstreamRoute | null {
  if (method === "POST") {
    // POST /bots — dispatch a bot to a live meeting
    if (segments.length === 1 && segments[0] === "bots") return { path: "/bots" };
    // POST /user/calendars — connect a new ICS calendar
    if (segments.length === 2 && segments[0] === "user" && segments[1] === "calendars") {
      return { path: "/user/calendars" };
    }
    // POST /user/calendars/<id>/sync — trigger a sync for a single calendar
    if (
      segments.length === 4 &&
      segments[0] === "user" && segments[1] === "calendars" && segments[3] === "sync" &&
      SAFE_CAL_ID.test(segments[2])
    ) {
      return { path: `/user/calendars/${encodeURIComponent(segments[2])}/sync` };
    }
    // POST /meetings/<id>/annotate — the caller's own title/metadata, {title}. Used for the
    // inline rename (DB-42): unlike PATCH /meetings/<id> below, meeting-api's annotate route
    // works in ANY meeting status, because it writes the caller's DESCRIPTION rather than the
    // dispatch instructions the FSM owns once a bot has been sent. A rename is exactly the case
    // annotate exists for — most meetings a person renames have already completed, and PATCH
    // refuses those with 409 ("no longer planned").
    if (
      segments.length === 3 && segments[0] === "meetings" && segments[2] === "annotate" &&
      /^\d{1,20}$/.test(segments[1])
    ) {
      return { path: `/meetings/${encodeURIComponent(segments[1])}/annotate` };
    }
  }
  if (method === "PATCH") {
    // PATCH /user/calendars/<id> — update auto-join / bot-name / enabled / ics-url
    if (
      segments.length === 3 && segments[0] === "user" && segments[1] === "calendars" &&
      SAFE_CAL_ID.test(segments[2])
    ) {
      return { path: `/user/calendars/${encodeURIComponent(segments[2])}` };
    }
  }
  if (method === "DELETE") {
    // DELETE /user/calendars/<id> — disconnect a calendar
    if (
      segments.length === 3 && segments[0] === "user" && segments[1] === "calendars" &&
      SAFE_CAL_ID.test(segments[2])
    ) {
      return { path: `/user/calendars/${encodeURIComponent(segments[2])}` };
    }
    // DELETE /meetings/<id> — delete a planned row, or wipe a completed meeting's transcript +
    // recording (meeting-api's own two branches; the client's confirm text names both).
    if (segments.length === 2 && segments[0] === "meetings" && /^\d{1,20}$/.test(segments[1])) {
      return { path: `/meetings/${encodeURIComponent(segments[1])}` };
    }
    // DELETE /bots/<platform>/<native> — Stop recording (DB-41).
    if (
      segments.length === 3 && segments[0] === "bots" &&
      PLATFORMS.has(segments[1]) && SAFE_SEGMENT.test(segments[2])
    ) {
      return { path: `/bots/${segments[1]}/${encodeURIComponent(segments[2])}` };
    }
  }
  return null;
}

/** Filter an incoming query string down to the ONE route's own declared `query` shape, preserving
 *  order.
 *
 *  This used to be one `ALLOWED_QUERY` set of names (`limit`/`offset`/`cursor`) applied to every
 *  proxied GET regardless of which route it was. That shape is unsafe by construction: any name
 *  added to that one set would ride along to EVERY route this file resolves, including ones that
 *  never asked for it. DB-44 needed a free-text `q` param for `transcripts/search` — adding `q` to
 *  a global list would have forwarded a free-text parameter to `/meetings`, `/user/calendars`,
 *  every other GET here, none of which take one. So the allowlist moved onto `UpstreamRoute`
 *  itself: each route declares the exact params it takes, each with its own shape check (a bounded
 *  int for `limit`/`offset`, a length cap for `q`), and a param a route did not declare is dropped
 *  — never forwarded on the strength of its name alone. A route with no `query` at all (most of
 *  them) forwards no query string, full stop.
 */
export function filterQuery(route: UpstreamRoute, search: URLSearchParams): string {
  const allowed = route.query;
  if (!allowed) return "";
  const out = new URLSearchParams();
  for (const [k, v] of search) {
    const check = allowed[k];
    if (check && check(v)) out.append(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}
