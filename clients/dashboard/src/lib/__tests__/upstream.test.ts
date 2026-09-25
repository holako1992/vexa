/** The allowlist is the dashboard's whole attack surface towards the gateway, so it is tested as
 *  a table: what it admits, and — the part that matters — what it refuses. */
import { describe, expect, it } from "vitest";
import { filterQuery, resolveUpstream, resolveWriteUpstream } from "../upstream";

describe("resolveUpstream", () => {
  it("admits the four read paths the product has", () => {
    expect(resolveUpstream(["meetings"])).toEqual({ path: "/meetings" });
    expect(resolveUpstream(["meetings", "42"])).toEqual({ path: "/meetings/42" });
    expect(resolveUpstream(["transcripts", "by-id", "42"])).toEqual({ path: "/transcripts/by-id/42" });
    expect(resolveUpstream(["transcripts", "google_meet", "abc-defg-hij"])).toEqual({
      path: "/transcripts/google_meet/abc-defg-hij",
    });
  });

  it("refuses every other gateway edge", () => {
    for (const path of [["bots"], ["agent", "chat"], ["admin", "users"], []]) {
      expect(resolveUpstream(path)).toBeNull();
    }
  });

  it("resolves GET meetings/<id> to the single-row route, refusing non-numeric shapes", () => {
    expect(resolveUpstream(["meetings", "1"])).toEqual({ path: "/meetings/1" });
    expect(resolveUpstream(["meetings", "42abc"])).toBeNull();
    expect(resolveUpstream(["meetings", "../../admin"])).toBeNull();
    expect(resolveUpstream(["meetings", "1/2"])).toBeNull();
    expect(resolveUpstream(["meetings", "x".repeat(21)])).toBeNull();
    expect(resolveUpstream(["meetings", ""])).toBeNull();
    expect(resolveUpstream(["meetings"])).toEqual({ path: "/meetings" }); // no id: unaffected
  });

  it("does not shadow, or get shadowed by, transcripts/by-id/<id>", () => {
    expect(resolveUpstream(["meetings", "42"])).toEqual({ path: "/meetings/42" });
    expect(resolveUpstream(["transcripts", "by-id", "42"])).toEqual({ path: "/transcripts/by-id/42" });
    expect(resolveUpstream(["meetings", "by-id"])).toBeNull(); // "by-id" is not a numeric row id
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

describe("resolveUpstream — entitlements (DB-75)", () => {
  it("admits GET user/entitlements", () => {
    expect(resolveUpstream(["user", "entitlements"])).toEqual({ path: "/user/entitlements" });
  });

  it("refuses near-misses and writes to the same path", () => {
    for (const path of [
      ["user", "entitlement"],
      ["users", "entitlements"],
      ["user", "entitlements", "extra"],
      ["entitlements"],
    ]) {
      expect(resolveUpstream(path)).toBeNull();
    }
    expect(resolveWriteUpstream("POST", ["user", "entitlements"])).toBeNull();
    expect(resolveWriteUpstream("PATCH", ["user", "entitlements"])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["user", "entitlements"])).toBeNull();
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

describe("resolveUpstream — meeting summary (DB-60)", () => {
  it("composes the workspace file path from the numeric id alone", () => {
    expect(resolveUpstream(["meetings", "104", "summary"])).toEqual({
      path: "/agent/workspace/file?path=meetings/104/summary.md",
    });
  });

  it("refuses a non-numeric, traversal, or encoded-slash id", () => {
    for (const id of ["104abc", "../../admin", "1%2f2", "1/2", "", "x".repeat(21)]) {
      expect(resolveUpstream(["meetings", id, "summary"])).toBeNull();
    }
  });

  it("refuses anything but the exact 'summary' tail segment", () => {
    expect(resolveUpstream(["meetings", "104", "notes"])).toBeNull();
    expect(resolveUpstream(["meetings", "104", "summary", "extra"])).toBeNull();
  });

  // The caller can never steer the upstream `path=` query — see route.ts, which drops the whole
  // incoming query string whenever the resolved path already carries one. Proven at the route
  // level in route.test.ts; this just fixes the resolved shape the route depends on.
  it("the resolved path is fixed and carries no room for a caller-supplied 'path'", () => {
    const route = resolveUpstream(["meetings", "104", "summary"]);
    expect(route?.path).not.toContain("&");
    expect(route?.path.match(/path=/g)?.length).toBe(1);
  });
});

describe("resolveUpstream — participants (DB-42)", () => {
  it("admits a known platform + safe native id", () => {
    expect(resolveUpstream(["meetings", "google_meet", "abc-defg-hij", "participants"])).toEqual({
      path: "/meetings/google_meet/abc-defg-hij/participants",
    });
  });

  it("refuses an unknown platform, a separator-bearing native id, or a near-miss tail", () => {
    expect(resolveUpstream(["meetings", "webex", "x", "participants"])).toBeNull();
    expect(resolveUpstream(["meetings", "google_meet", "a/b", "participants"])).toBeNull();
    expect(resolveUpstream(["meetings", "google_meet", "", "participants"])).toBeNull();
    expect(resolveUpstream(["meetings", "google_meet", "x", "roster"])).toBeNull();
    expect(resolveUpstream(["meetings", "google_meet", "x"])).toBeNull();
  });
});

describe("resolveUpstream — bots/status (DB-41)", () => {
  it("admits GET bots/status", () => {
    expect(resolveUpstream(["bots", "status"])).toEqual({ path: "/bots/status" });
  });

  it("refuses near-misses", () => {
    for (const path of [["bots"], ["bots", "status", "extra"], ["bot", "status"]]) {
      expect(resolveUpstream(path)).toBeNull();
    }
  });
});

describe("resolveWriteUpstream — stop recording (DB-41)", () => {
  it("admits DELETE bots/<platform>/<native> for a known platform", () => {
    expect(resolveWriteUpstream("DELETE", ["bots", "google_meet", "abc-defg-hij"])).toEqual({
      path: "/bots/google_meet/abc-defg-hij",
    });
  });

  it("refuses an unknown platform, a separator-bearing native id, and the wrong method", () => {
    expect(resolveWriteUpstream("DELETE", ["bots", "webex", "x"])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["bots", "google_meet", "a/b"])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["bots", "google_meet", ""])).toBeNull();
    expect(resolveWriteUpstream("POST", ["bots", "google_meet", "x"])).toBeNull();
    expect(resolveWriteUpstream("PATCH", ["bots", "google_meet", "x"])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["bots", "google_meet"])).toBeNull();
  });

  it("percent-encodes a native id with URL-significant characters", () => {
    expect(resolveWriteUpstream("DELETE", ["bots", "teams", "19:meeting_x@thread.v2"])?.path).toBe(
      "/bots/teams/19%3Ameeting_x%40thread.v2",
    );
  });
});

describe("resolveWriteUpstream — rename via annotate, and delete (DB-42)", () => {
  it("admits POST meetings/<id>/annotate for a numeric id", () => {
    expect(resolveWriteUpstream("POST", ["meetings", "104", "annotate"])).toEqual({
      path: "/meetings/104/annotate",
    });
  });

  it("refuses a non-numeric id or the wrong tail on annotate", () => {
    expect(resolveWriteUpstream("POST", ["meetings", "104abc", "annotate"])).toBeNull();
    expect(resolveWriteUpstream("POST", ["meetings", "../../admin", "annotate"])).toBeNull();
    expect(resolveWriteUpstream("POST", ["meetings", "104", "notes"])).toBeNull();
    expect(resolveWriteUpstream("PATCH", ["meetings", "104", "annotate"])).toBeNull();
  });

  it("admits DELETE meetings/<id> for a numeric id", () => {
    expect(resolveWriteUpstream("DELETE", ["meetings", "104"])).toEqual({ path: "/meetings/104" });
  });

  it("refuses a non-numeric meetings id, and PATCH meetings/<id> outright (not on the write allowlist)", () => {
    expect(resolveWriteUpstream("DELETE", ["meetings", "104abc"])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["meetings", ""])).toBeNull();
    expect(resolveWriteUpstream("DELETE", ["meetings", "104", "extra"])).toBeNull();
    expect(resolveWriteUpstream("PATCH", ["meetings", "104"])).toBeNull();
    expect(resolveWriteUpstream("GET", ["meetings", "104"])).toBeNull();
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
