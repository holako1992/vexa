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

export interface UpstreamRoute {
  /** The gateway path this request maps to, with its segments already encoded. */
  path: string;
}

/** Platform ids meeting-api accepts. A transcript path is only built for one of these — an
 *  arbitrary segment would let a caller shape the upstream URL. */
const PLATFORMS = new Set(["google_meet", "teams", "zoom", "jitsi"]);

/** One path segment with no separators — the shape every id below must have before it is
 *  interpolated into an upstream URL. */
const SAFE_SEGMENT = /^[^/?#\s]{1,256}$/;

/** Map a `/api/vexa/<...segments>` GET to its gateway path, or null to refuse.
 *
 *  Recognised:
 *    meetings                        → /meetings                      (the caller's meeting rows)
 *    meetings/<meetingId>            → /meetings/<meetingId>          (owner-scoped, row-keyed)
 *    transcripts/by-id/<meetingId>   → /transcripts/by-id/<meetingId> (owner-scoped, row-keyed)
 *    transcripts/<platform>/<native> → /transcripts/<platform>/<native>
 *
 *  Every one is a read. The dashboard issues no writes, so `resolveUpstream` is only ever
 *  consulted for GET and the route refuses every other method before it is called.
 */
export function resolveUpstream(segments: readonly string[]): UpstreamRoute | null {
  if (segments.length === 1 && segments[0] === "meetings") return { path: "/meetings" };

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

/** Query parameters that may ride along to the gateway. Everything else is dropped rather than
 *  forwarded blind — an unrecognised parameter is either a caller's mistake or someone probing
 *  the upstream, and neither deserves a pass-through. */
const ALLOWED_QUERY = new Set(["limit", "offset", "cursor"]);

/** Filter an incoming query string down to the allowlist above, preserving order. */
export function filterQuery(search: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const [k, v] of search) if (ALLOWED_QUERY.has(k)) out.append(k, v);
  const s = out.toString();
  return s ? `?${s}` : "";
}
