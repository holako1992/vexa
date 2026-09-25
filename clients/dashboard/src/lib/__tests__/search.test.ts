/** DB-44's two pure transforms: grouping search hits by meeting, and splitting a snippet into
 *  plain/matched segments for highlighting — weighted towards the cases that would otherwise
 *  reshuffle a producer's rank order or leak raw HTML. */
import { describe, expect, it } from "vitest";
import { groupHitsByMeeting, highlightSnippet, type SearchHit } from "../search";

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    meeting_db_id: 1,
    platform: "google_meet",
    native_meeting_id: "abc",
    start: 0,
    end: 2,
    speaker: "Ana",
    rank: 1,
    snippet: "the latency numbers look fine",
    ...over,
  };
}

describe("groupHitsByMeeting", () => {
  it("groups repeated hits for the same meeting into one entry", () => {
    const hits = [hit({ meeting_db_id: 1, start: 0 }), hit({ meeting_db_id: 1, start: 10 })];
    const groups = groupHitsByMeeting(hits);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hits).toHaveLength(2);
  });

  it("keeps groups in first-seen (producer rank) order, never re-sorted", () => {
    const hits = [
      hit({ meeting_db_id: 2, rank: 1 }),
      hit({ meeting_db_id: 1, rank: 5 }), // higher rank, but arrives second — order is NOT by rank
      hit({ meeting_db_id: 2, rank: 0.5 }),
    ];
    const groups = groupHitsByMeeting(hits);
    expect(groups.map((g) => g.meetingDbId)).toEqual([2, 1]);
  });

  it("an empty hit list produces no groups", () => {
    expect(groupHitsByMeeting([])).toEqual([]);
  });

  it("carries the platform and native id from the group's hits", () => {
    const groups = groupHitsByMeeting([hit({ meeting_db_id: 9, platform: "zoom", native_meeting_id: "z-1" })]);
    expect(groups[0]).toMatchObject({ meetingDbId: 9, platform: "zoom", nativeMeetingId: "z-1" });
  });
});

describe("highlightSnippet", () => {
  it("marks a single matched word", () => {
    const segs = highlightSnippet("the latency numbers look fine", "latency");
    expect(segs.map((s) => [s.text, s.matched])).toEqual([
      ["the ", false],
      ["latency", true],
      [" numbers look fine", false],
    ]);
  });

  it("marks every occurrence of multiple terms, case-insensitively", () => {
    const segs = highlightSnippet("Pricing came up, pricing again", "pricing");
    const matched = segs.filter((s) => s.matched).map((s) => s.text);
    expect(matched).toEqual(["Pricing", "pricing"]);
  });

  it("marks a quoted phrase as one unit, not its individual words", () => {
    const segs = highlightSnippet('we should revisit the pricing model', '"the pricing"');
    expect(segs.some((s) => s.matched && s.text.toLowerCase() === "the pricing")).toBe(true);
  });

  it("does not highlight a -negated term", () => {
    const segs = highlightSnippet("pricing came up again", "pricing -came");
    expect(segs.every((s) => !(s.matched && s.text.toLowerCase() === "came"))).toBe(true);
  });

  it("returns the whole snippet unmatched when the query has no usable terms", () => {
    expect(highlightSnippet("hello world", "-only-negated")).toEqual([{ text: "hello world", matched: false }]);
  });

  it("returns no segments for an empty snippet", () => {
    expect(highlightSnippet("", "pricing")).toEqual([]);
  });

  it("never needs dangerouslySetInnerHTML — segments are plain text, HTML-looking terms included", () => {
    const segs = highlightSnippet("a <script>alert(1)</script> tag", "<script>");
    expect(segs.every((s) => typeof s.text === "string")).toBe(true);
    // the term is escaped for the REGEX, not for HTML — it's still literal text, safe to render as
    // a React text node, never as markup.
    expect(segs.some((s) => s.matched && s.text === "<script>")).toBe(true);
  });
});
