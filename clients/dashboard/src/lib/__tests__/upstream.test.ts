/** The allowlist is the dashboard's whole attack surface towards the gateway, so it is tested as
 *  a table: what it admits, and — the part that matters — what it refuses. */
import { describe, expect, it } from "vitest";
import { filterQuery, resolveUpstream } from "../upstream";

describe("resolveUpstream", () => {
  it("admits the three read paths the product has", () => {
    expect(resolveUpstream(["meetings"])).toEqual({ path: "/meetings" });
    expect(resolveUpstream(["transcripts", "by-id", "42"])).toEqual({ path: "/transcripts/by-id/42" });
    expect(resolveUpstream(["transcripts", "google_meet", "abc-defg-hij"])).toEqual({
      path: "/transcripts/google_meet/abc-defg-hij",
    });
  });

  it("refuses every other gateway edge", () => {
    for (const path of [["bots"], ["agent", "chat"], ["admin", "users"], ["meetings", "42"], []]) {
      expect(resolveUpstream(path)).toBeNull();
    }
  });

  it("refuses an unknown platform rather than building a URL from it", () => {
    expect(resolveUpstream(["transcripts", "../admin", "x"])).toBeNull();
    expect(resolveUpstream(["transcripts", "webex", "x"])).toBeNull();
  });

  it("refuses a non-numeric row id and a separator-bearing native id", () => {
    expect(resolveUpstream(["transcripts", "by-id", "42abc"])).toBeNull();
    expect(resolveUpstream(["transcripts", "by-id", "../../admin"])).toBeNull();
    expect(resolveUpstream(["transcripts", "google_meet", "a/b"])).toBeNull();
    expect(resolveUpstream(["transcripts", "google_meet", ""])).toBeNull();
  });

  it("percent-encodes a native id that carries URL-significant characters", () => {
    expect(resolveUpstream(["transcripts", "teams", "19:meeting_x@thread.v2"])?.path).toBe(
      "/transcripts/teams/19%3Ameeting_x%40thread.v2",
    );
  });
});

describe("filterQuery", () => {
  it("keeps the paging parameters and drops everything else", () => {
    const q = new URLSearchParams("limit=10&offset=5&user_id=7&x=1");
    expect(filterQuery(q)).toBe("?limit=10&offset=5");
  });

  it("returns an empty string when nothing survives", () => {
    expect(filterQuery(new URLSearchParams("user_id=7"))).toBe("");
    expect(filterQuery(new URLSearchParams(""))).toBe("");
  });
});
