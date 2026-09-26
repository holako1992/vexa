/** The allowlist is the dashboard's whole attack surface towards the gateway, so it is tested as
 *  a table: what it admits, and — the part that matters — what it refuses. */
import { describe, expect, it } from "vitest";
import { filterQuery, resolveUpstream, resolveWriteUpstream, validateBody } from "../upstream";

describe("resolveUpstream", () => {
  it("admits the four read paths the product has", () => {
    expect(resolveUpstream(["meetings"])).toEqual({ path: "/meetings", query: expect.any(Object) });
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
    expect(resolveUpstream(["meetings"])).toEqual({ path: "/meetings", query: expect.any(Object) }); // no id: unaffected
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

describe("resolveUpstream — Google calendar authorize (DB-31)", () => {
  it("admits GET user/calendars/google/authorize", () => {
    expect(resolveUpstream(["user", "calendars", "google", "authorize"])).toEqual({
      path: "/user/calendars/google/authorize",
    });
  });

  it("refuses near-misses: wrong segment, extra segment, and the exchange path (POST-only)", () => {
    for (const path of [
      ["user", "calendars", "google"],
      ["user", "calendars", "google", "exchange"],
      ["user", "calendars", "microsoft", "authorize"],
      ["user", "calendars", "google", "authorize", "extra"],
      ["users", "calendars", "google", "authorize"],
    ]) {
      expect(resolveUpstream(path)).toBeNull();
    }
    expect(resolveWriteUpstream("POST", ["user", "calendars", "google", "authorize"])).toBeNull();
    expect(resolveWriteUpstream("GET", ["user", "calendars", "google", "authorize"])).toBeNull();
  });
});

describe("resolveWriteUpstream — Google calendar exchange (DB-31)", () => {
  it("admits POST /user/calendars/google/exchange with a body check attached", () => {
    expect(resolveWriteUpstream("POST", ["user", "calendars", "google", "exchange"])).toEqual({
      path: "/user/calendars/google/exchange",
      body: expect.any(Function),
    });
  });

  it("refuses method/path near-misses, including the authorize path (GET-only)", () => {
    for (const [method, path] of [
      ["GET", ["user", "calendars", "google", "exchange"]],
      ["PATCH", ["user", "calendars", "google", "exchange"]],
      ["DELETE", ["user", "calendars", "google", "exchange"]],
      ["POST", ["user", "calendars", "google", "authorize"]],
      ["POST", ["user", "calendars", "google"]],
      ["POST", ["user", "calendars", "google", "exchange", "extra"]],
      ["POST", ["user", "calendars", "microsoft", "exchange"]],
    ] as const) {
      expect(resolveWriteUpstream(method, path)).toBeNull();
    }
  });
});

describe("validateBody — user/calendars/google/exchange (DB-31)", () => {
  const exchange = resolveWriteUpstream("POST", ["user", "calendars", "google", "exchange"])!;
  // A shape matching `google_oauth.sign_state`'s two dot-separated base64url segments — this
  // allowlist checks the SHAPE only, never validity (see `isGoogleExchangeBody`'s comment in
  // upstream.ts): the core alone signs and verifies it.
  const realState = "eyJ1aWQiOjF9.c2lnbmF0dXJl";

  it("admits exactly {code, state}, both plausible strings", () => {
    expect(validateBody(exchange, JSON.stringify({ code: "4/0Ab_test-code", state: realState }))).toBe(true);
  });

  it("refuses extra keys, missing keys, wrong types, and non-object bodies", () => {
    expect(validateBody(exchange, JSON.stringify({ code: "abc", state: realState, extra: 1 }))).toBe(false);
    expect(validateBody(exchange, JSON.stringify({ code: "abc" }))).toBe(false);
    expect(validateBody(exchange, JSON.stringify({ state: realState }))).toBe(false);
    expect(validateBody(exchange, JSON.stringify({ code: 1, state: realState }))).toBe(false);
    expect(validateBody(exchange, JSON.stringify({ code: "abc", state: 1 }))).toBe(false);
    expect(validateBody(exchange, JSON.stringify(["abc", realState]))).toBe(false);
    expect(validateBody(exchange, JSON.stringify(null))).toBe(false);
  });

  it("refuses a state that isn't the signed token's two-segment shape", () => {
    for (const state of ["", "no-dot-here", "a.b.c", ".", "short.short", "a".repeat(2049) + "." + "b".repeat(8)]) {
      expect(validateBody(exchange, JSON.stringify({ code: "abc", state }))).toBe(false);
    }
  });

  it("refuses an empty code, an overlong code, and a code carrying a newline", () => {
    expect(validateBody(exchange, JSON.stringify({ code: "", state: realState }))).toBe(false);
    expect(validateBody(exchange, JSON.stringify({ code: "x".repeat(2049), state: realState }))).toBe(false);
    expect(validateBody(exchange, JSON.stringify({ code: "abc\ndef", state: realState }))).toBe(false);
  });

  it("refuses an empty body and malformed JSON", () => {
    expect(validateBody(exchange, "")).toBe(false);
    expect(validateBody(exchange, "{not json")).toBe(false);
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

describe("resolveWriteUpstream — billing checkout/portal (DB-74b)", () => {
  it("admits POST /billing/checkout and POST /billing/portal", () => {
    expect(resolveWriteUpstream("POST", ["billing", "checkout"])).toEqual({
      path: "/billing/checkout",
      body: expect.any(Function),
    });
    expect(resolveWriteUpstream("POST", ["billing", "portal"])).toEqual({
      path: "/billing/portal",
      body: expect.any(Function),
    });
  });

  it("refuses method/path near-misses", () => {
    for (const [method, path] of [
      ["GET", ["billing", "checkout"]],
      ["PATCH", ["billing", "checkout"]],
      ["DELETE", ["billing", "checkout"]],
      ["GET", ["billing", "portal"]],
      ["POST", ["billing", "checkouts"]],
      ["POST", ["billings", "checkout"]],
      ["POST", ["billing"]],
      ["POST", ["billing", "checkout", "extra"]],
      ["POST", ["billing", "webhook"]], // Stripe's own route — signature-authenticated, never a
      // user-tier write this allowlist should ever admit.
    ] as const) {
      expect(resolveWriteUpstream(method, path)).toBeNull();
    }
  });
});

describe("validateBody — billing/checkout, billing/portal (DB-74b)", () => {
  const checkout = resolveWriteUpstream("POST", ["billing", "checkout"])!;
  const portal = resolveWriteUpstream("POST", ["billing", "portal"])!;

  it("admits exactly {plan, interval} with a real catalog plan and interval", () => {
    expect(validateBody(checkout, JSON.stringify({ plan: "pro", interval: "month" }))).toBe(true);
    expect(validateBody(checkout, JSON.stringify({ plan: "team", interval: "year" }))).toBe(true);
  });

  it("refuses a plan outside the paid catalog, including the free plan", () => {
    for (const plan of ["free", "Pro", "enterprise", "pro ", "", "PRO"]) {
      expect(validateBody(checkout, JSON.stringify({ plan, interval: "month" }))).toBe(false);
    }
  });

  it("refuses an interval that isn't exactly 'month' or 'year'", () => {
    for (const interval of ["monthly", "yearly", "Month", "annual", "", "year "]) {
      expect(validateBody(checkout, JSON.stringify({ plan: "pro", interval }))).toBe(false);
    }
  });

  it("refuses extra keys, missing keys, wrong types, and non-object bodies", () => {
    expect(validateBody(checkout, JSON.stringify({ plan: "pro", interval: "month", extra: 1 }))).toBe(false);
    expect(validateBody(checkout, JSON.stringify({ plan: "pro" }))).toBe(false);
    expect(validateBody(checkout, JSON.stringify({ plan: 1, interval: "month" }))).toBe(false);
    expect(validateBody(checkout, JSON.stringify(["pro", "month"]))).toBe(false);
    expect(validateBody(checkout, JSON.stringify("pro"))).toBe(false);
    expect(validateBody(checkout, JSON.stringify(null))).toBe(false);
  });

  it("refuses an empty body and malformed JSON on checkout", () => {
    expect(validateBody(checkout, "")).toBe(false);
    expect(validateBody(checkout, "{not json")).toBe(false);
  });

  it("admits only an empty body on portal, refusing anything sent at all", () => {
    expect(validateBody(portal, "")).toBe(true);
    expect(validateBody(portal, JSON.stringify({}))).toBe(false);
    expect(validateBody(portal, JSON.stringify({ plan: "pro" }))).toBe(false);
    expect(validateBody(portal, "{not json")).toBe(false);
  });

  it("a route with no body validator admits any body unchanged (pre-DB-74b routes)", () => {
    const bots = resolveWriteUpstream("POST", ["bots"])!;
    expect(validateBody(bots, JSON.stringify({ anything: "goes", nested: { a: 1 } }))).toBe(true);
    expect(validateBody(bots, "")).toBe(true);
    expect(validateBody(bots, "not even json")).toBe(true);
  });
});

describe("resolveUpstream — transcripts/search (DB-44)", () => {
  it("admits GET transcripts/search with its own query shape", () => {
    expect(resolveUpstream(["transcripts", "search"])).toEqual({
      path: "/transcripts/search",
      query: expect.any(Object),
    });
  });

  it("is not shadowed by, and does not shadow, transcripts/<platform>/<native>", () => {
    expect(resolveUpstream(["transcripts", "search"])?.path).toBe("/transcripts/search");
    expect(resolveUpstream(["transcripts", "google_meet", "abc"])).toEqual({
      path: "/transcripts/google_meet/abc",
    });
    // "search" is never treated as a platform slug — PLATFORMS doesn't contain it, but the
    // explicit branch above must win regardless, since it is checked first.
    expect(resolveUpstream(["transcripts", "search", "extra"])).toBeNull();
  });
});

describe("filterQuery — per-route allowlist (DB-44/DB-48)", () => {
  it("meetings keeps limit/offset and drops everything else, including q", () => {
    const route = resolveUpstream(["meetings"])!;
    const q = new URLSearchParams("limit=10&offset=5&user_id=7&x=1&q=pricing");
    expect(filterQuery(route, q)).toBe("?limit=10&offset=5");
  });

  it("transcripts/search keeps q, limit and offset", () => {
    const route = resolveUpstream(["transcripts", "search"])!;
    const q = new URLSearchParams("q=pricing&limit=10&offset=5&user_id=7");
    expect(filterQuery(route, q)).toBe("?q=pricing&limit=10&offset=5");
  });

  it("q is dropped on a route that does not declare it (meetings)", () => {
    const route = resolveUpstream(["meetings"])!;
    expect(filterQuery(route, new URLSearchParams("q=pricing"))).toBe("");
  });

  it("q is dropped on a route with no query shape at all (meetings/<id>)", () => {
    const route = resolveUpstream(["meetings", "42"])!;
    expect(filterQuery(route, new URLSearchParams("q=pricing&limit=10"))).toBe("");
  });

  it("an over-long q is refused (dropped), not truncated", () => {
    const route = resolveUpstream(["transcripts", "search"])!;
    const tooLong = "x".repeat(513); // meeting-api's SEARCH_QUERY_MAX_CHARS is 512
    const atLimit = "x".repeat(512);
    expect(filterQuery(route, new URLSearchParams({ q: tooLong }))).toBe("");
    expect(filterQuery(route, new URLSearchParams({ q: atLimit })).length).toBeGreaterThan(0);
  });

  it("a blank q is refused", () => {
    const route = resolveUpstream(["transcripts", "search"])!;
    expect(filterQuery(route, new URLSearchParams({ q: "" }))).toBe("");
  });

  it("non-numeric limit is dropped", () => {
    const route = resolveUpstream(["meetings"])!;
    for (const bad of ["abc", "1.5", "-1", "1e3", " 1", "1 ", "+1"]) {
      expect(filterQuery(route, new URLSearchParams({ limit: bad }))).toBe("");
    }
  });

  it("limit outside 1–100 is dropped; the boundary values are kept", () => {
    const route = resolveUpstream(["meetings"])!;
    expect(filterQuery(route, new URLSearchParams({ limit: "0" }))).toBe("");
    expect(filterQuery(route, new URLSearchParams({ limit: "101" }))).toBe("");
    expect(filterQuery(route, new URLSearchParams({ limit: "1" }))).toBe("?limit=1");
    expect(filterQuery(route, new URLSearchParams({ limit: "100" }))).toBe("?limit=100");
  });

  it("negative offset is dropped", () => {
    const route = resolveUpstream(["meetings"])!;
    expect(filterQuery(route, new URLSearchParams({ offset: "-5" }))).toBe("");
  });

  it("returns an empty string when nothing survives, or the route takes no query", () => {
    expect(filterQuery(resolveUpstream(["meetings"])!, new URLSearchParams("user_id=7"))).toBe("");
    expect(filterQuery(resolveUpstream(["meetings", "42"])!, new URLSearchParams("limit=10"))).toBe("");
  });
});
