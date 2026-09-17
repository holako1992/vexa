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
 *    transcripts/by-id/<meetingId>   → /transcripts/by-id/<meetingId> (owner-scoped, row-keyed)
 *    transcripts/<platform>/<native> → /transcripts/<platform>/<native>
 *
 *  Every one is a read. The dashboard issues no writes, so `resolveUpstream` is only ever
 *  consulted for GET and the route refuses every other method before it is called.
 */
export function resolveUpstream(segments: readonly string[]): UpstreamRoute | null {
  if (segments.length === 1 && segments[0] === "meetings") return { path: "/meetings" };

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
