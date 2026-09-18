/** The allowlist is the dashboard's whole attack surface towards the gateway, so it is tested as
 *  a table: what it admits, and — the part that matters — what it refuses. */
import { describe, expect, it } from "vitest";
import { filterQuery, resolveUpstream, resolveWriteUpstream } from "../upstream";

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

describe("resolveUpstream — read extras", () => {
  it("admits GET user/calendars and GET meeting/jitsi-hosts", () => {
    expect(resolveUpstream(["user", "calendars"])).toEqual({ path: "/user/calendars" });
    expect(resolveUpstream(["meeting", "jitsi-hosts"])).toEqual({ path: "/meeting/jitsi-hosts" });
  });

  it("refuses near-misses on the read extras", () => {
    for (const path of [
      ["user", "calendars", "1"],
      ["user", "calendar"],
      ["users", "calendars"],
      ["meeting", "jitsi-host"],
      ["meeting", "jitsi-hosts", "extra"],
      ["jitsi-hosts"],
    ]) {
      expect(resolveUpstream(path)).toBeNull();
    }
  });
});

describe("resolveWriteUpstream", () => {
  it("admits POST /bots", () => {
    expect(resolveWriteUpstream("POST", ["bots"])).toEqual({ path: "/bots" });
  });

  it("admits POST /user/calendars", () => {
    expect(resolveWriteUpstream("POST", ["user", "calendars"])).toEqual({ path: "/user/calendars" });
  });

  it("admits POST /user/calendars/<id>/sync", () => {
    expect(resolveWriteUpstream("POST", ["user", "calendars", "cal-1", "sync"])).toEqual({
      path: "/user/calendars/cal-1/sync",
    });
  });

  it("admits PATCH /user/calendars/<id>", () => {
    expect(resolveWriteUpstream("PATCH", ["user", "calendars", "cal-1"])).toEqual({
      path: "/user/calendars/cal-1",
    });
  });

  it("admits DELETE /user/calendars/<id>", () => {
    expect(resolveWriteUpstream("DELETE", ["user", "calendars", "cal-1"])).toEqual({
      path: "/user/calendars/cal-1",
    });
  });

  it("percent-encodes a calendar id that carries URL-significant characters", () => {
    // SAFE_CAL_ID forbids '/','?','#' and whitespace, but a literal '@' or ':' is admitted and
    // must be encoded before it reaches the upstream URL.
    expect(resolveWriteUpstream("PATCH", ["user", "calendars", "a@b:c"])?.path).toBe(
      "/user/calendars/a%40b%3Ac",
    );
  });

  it("refuses method/path mismatches", () => {
    expect(resolveWriteUpstream("PATCH", ["bots"])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["bots"])).toBeNull();
    expect(resolveWriteUpstream("GET", ["bots"])).toBeNull();
    expect(resolveWriteUpstream("POST", ["user", "calendars", "cal-1"])).toBeNull(); // no /sync
    expect(resolveWriteUpstream("PATCH", ["user", "calendars", "cal-1", "sync"])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["user", "calendars", "cal-1", "sync"])).toBeNull();
    expect(resolveWriteUpstream("GET", ["user", "calendars"])).toBeNull();
    expect(resolveWriteUpstream("POST", ["user", "calendar"])).toBeNull();
    expect(resolveWriteUpstream("POST", ["users", "calendars"])).toBeNull();
    expect(resolveWriteUpstream("POST", [])).toBeNull();
  });

  it("refuses a calendar id that fails SAFE_CAL_ID", () => {
    const bad = ["a/b", "a?b", "a#b", "a b", "a\tb", "x".repeat(129)];
    for (const id of bad) {
      expect(resolveWriteUpstream("PATCH", ["user", "calendars", id])).toBeNull();
      expect(resolveWriteUpstream("DELETE", ["user", "calendars", id])).toBeNull();
      expect(resolveWriteUpstream("POST", ["user", "calendars", id, "sync"])).toBeNull();
    }
  });

  it("admits a calendar id at exactly the 128-char boundary", () => {
    const id = "x".repeat(128);
    expect(resolveWriteUpstream("PATCH", ["user", "calendars", id])).toEqual({
      path: `/user/calendars/${id}`,
    });
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
