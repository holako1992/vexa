/** DB-44 — global search: the shapes `GET /transcripts/search` returns, and the two pure
 *  transforms the `/search` page needs (grouping by meeting, highlighting the matched terms in a
 *  snippet). Both are presentation only, same rule as `meetings.ts`: nothing here re-ranks a hit,
 *  re-orders one meeting's hits against another's, or invents a title the producer didn't send.
 */

/** One hit, exactly as `meeting_api/collector/app.py`'s `search_transcripts` returns it (see
 *  `meeting_api/collector/fakes.py`'s in-memory stand-in for the field list this mirrors).
 *  `meeting_db_id` — never `meeting_id` — is the numeric row id; it is what `resolveUpstream`'s
 *  `meetings/<id>` route needs to link to the meeting. */
export interface SearchHit {
  meeting_db_id: number;
  platform: string;
  native_meeting_id: string;
  start: number;
  end: number;
  speaker: string | null;
  language?: string | null;
  rank: number;
  snippet: string;
}

export interface SearchResponseDTO {
  query: string;
  hits: SearchHit[];
  count: number;
}

/** One meeting's hits, in first-seen order (the order `hits` already arrived in — ranked by the
 *  producer, never re-ranked here). */
export interface MeetingHitGroup {
  meetingDbId: number;
  platform: string;
  nativeMeetingId: string;
  hits: SearchHit[];
}

/** Group hits by the meeting they came from. A `Map` keyed by `meeting_db_id` so repeated hits for
 *  the same meeting collect into one group; groups keep the order their first hit appeared in,
 *  which is the producer's own rank order — grouping must not reshuffle that. */
export function groupHitsByMeeting(hits: readonly SearchHit[]): MeetingHitGroup[] {
  const order: number[] = [];
  const groups = new Map<number, MeetingHitGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.meeting_db_id);
    if (!group) {
      group = {
        meetingDbId: hit.meeting_db_id,
        platform: hit.platform,
        nativeMeetingId: hit.native_meeting_id,
        hits: [],
      };
      groups.set(hit.meeting_db_id, group);
      order.push(hit.meeting_db_id);
    }
    group.hits.push(hit);
  }
  return order.map((id) => groups.get(id)!);
}

export interface SnippetSegment {
  text: string;
  matched: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The same crude term extraction meeting-api's fake store uses to decide what to bold: quoted
 *  phrases first, then bare words, `-negated` words dropped (they were never something we matched
 *  ON, so highlighting them would point at the wrong words). Good enough for highlighting — it
 *  does not need to reproduce Postgres's tsquery semantics, only to bold words a reader typed. */
function extractTerms(query: string): string[] {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter(Boolean);
  const rest = query.replace(/"[^"]*"/g, " ");
  const words = rest
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !w.startsWith("-"));
  return [...phrases, ...words];
}

/** Split a snippet into plain/matched segments so the component can render `<mark>` around the
 *  matched ones — a pure data transform, never HTML. The snippet always renders as JSX built from
 *  this array, never through `dangerouslySetInnerHTML`: the same rule `SummaryPanel`'s `Inline`
 *  component follows for `**strong**` markup (see `components/README.md`). */
export function highlightSnippet(snippet: string, query: string): SnippetSegment[] {
  const terms = extractTerms(query);
  if (!snippet) return [];
  if (terms.length === 0) return [{ text: snippet, matched: false }];
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = snippet.split(pattern).filter((p) => p.length > 0);
  const lowerTerms = terms.map((t) => t.toLowerCase());
  return parts.map((text) => ({ text, matched: lowerTerms.includes(text.toLowerCase()) }));
}
