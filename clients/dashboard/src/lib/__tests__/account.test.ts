/** The account page's server logic and wording. `fetch` is replaced with a recorder, so these
 *  assert exactly which admin-api calls go out, for which user id, and what happens when one fails. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("../session", () => ({ sessionToken: async () => session.token }));

import { describeProvider, formatWhen, initialsOf, loginNotice, SIGNED_OUT_EVERYWHERE } from "../account";
import {
  loadAccount,
  providerFromData,
  resolveAccountCaller,
  revokeAllLoginSessions,
  sessionsFromTokens,
} from "../accountApi";

describe("providerFromData", () => {
  it("reads the recorded door", () => {
    expect(providerFromData({ identity: { provider: "google", email_verified: true, verified_at: "2026-09-01T00:00:00+00:00" } }))
      .toEqual({ provider: "google", emailVerified: true, verifiedAt: "2026-09-01T00:00:00+00:00" });
    expect(providerFromData({ identity: { provider: "email", email_verified: false } }))
      .toEqual({ provider: "email", emailVerified: false, verifiedAt: null });
  });

  it("treats a missing, malformed or unknown record as no record, never as unverified", () => {
    expect(providerFromData(undefined)).toBeNull();
    expect(providerFromData({})).toBeNull();
    expect(providerFromData({ identity: "google" })).toBeNull();
    expect(providerFromData({ identity: null })).toBeNull();
    expect(providerFromData({ identity: { provider: "github", email_verified: true } })).toBeNull();
    expect(providerFromData({ identity: { provider: "google", email_verified: "yes" } })?.emailVerified).toBe(false);
  });
});

describe("sessionsFromTokens", () => {
  it("lists only dashboard-login tokens, newest first, and exposes no token id or value", () => {
    const out = sessionsFromTokens([
      { id: 1, name: "dashboard-login", created_at: "2026-10-01T10:00:00" },
      { id: 2, name: "my-ci-key", created_at: "2026-10-05T10:00:00" },
      { id: 3, name: "terminal-login", created_at: "2026-10-06T10:00:00" },
      { id: 4, name: "dashboard-login", created_at: "2026-10-03T10:00:00", last_used_at: "2026-10-04T10:00:00" },
      { id: 5, name: null, created_at: "2026-10-07T10:00:00" },
    ]);
    expect(out).toEqual([
      { createdAt: "2026-10-03T10:00:00", lastUsedAt: "2026-10-04T10:00:00" },
      { createdAt: "2026-10-01T10:00:00", lastUsedAt: null },
    ]);
  });
});

describe("wording", () => {
  it("describes each door, and the absence of a record", () => {
    expect(describeProvider({ provider: "google", emailVerified: true, verifiedAt: null }))
      .toEqual({ label: "Google", detail: "Email address verified" });
    expect(describeProvider({ provider: "email", emailVerified: false, verifiedAt: null }))
      .toEqual({ label: "Email address", detail: "Email address not verified" });
    expect(describeProvider(null).label).toBe("Not recorded");
  });

  it("makes initials from a name, else the address", () => {
    expect(initialsOf("Ada Lovelace", "ada@x.test")).toBe("AL");
    expect(initialsOf(null, "grace.hopper@x.test")).toBe("GH");
    expect(initialsOf("  ", "q@x.test")).toBe("QX");
  });

  it("shows a dash for a time the core does not have", () => {
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen("not a date")).toBe("—");
    expect(formatWhen("2026-10-01T10:00:00Z")).not.toBe("—");
  });

  it("the login notice is selected by a fixed code only", () => {
    expect(loginNotice(SIGNED_OUT_EVERYWHERE)).toMatch(/signed out on every device/);
    expect(loginNotice("<script>alert(1)</script>")).toBeNull();
    expect(loginNotice(null)).toBeNull();
  });
});

describe("admin-api calls", () => {
  const calls: { url: string; method: string }[] = [];
  let tokenList: unknown[];
  let failDelete: Set<number>;
  const env = { ...process.env };

  beforeEach(() => {
    calls.length = 0;
    failDelete = new Set();
    tokenList = [
      { id: 10, name: "dashboard-login", created_at: "2026-10-01T10:00:00" },
      { id: 11, name: "my-ci-key", created_at: "2026-10-02T10:00:00" },
      { id: 12, name: "dashboard-login", created_at: "2026-10-03T10:00:00" },
    ];
    process.env.VEXA_ADMIN_API_URL = "http://admin.test";
    process.env.VEXA_ADMIN_API_KEY = "test-admin-key";
    process.env.VEXA_INTERNAL_API_SECRET = "test-internal-secret";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method || "GET";
      calls.push({ url, method });
      const path = new URL(url).pathname;
      if (path === "/internal/validate") {
        const { token } = JSON.parse(String(init.body));
        return token === "good-token"
          ? new Response(JSON.stringify({ user_id: 7, email: "me@x.test" }), { status: 200 })
          : new Response("{}", { status: 401 });
      }
      if (method === "GET" && path === "/admin/users/7/tokens") return new Response(JSON.stringify(tokenList), { status: 200 });
      if (method === "GET" && path === "/admin/users/7") {
        return new Response(JSON.stringify({ id: 7, email: "me@x.test", name: "Me", data: { identity: { provider: "google", email_verified: true } } }), { status: 200 });
      }
      const del = path.match(/^\/admin\/tokens\/(\d+)$/);
      if (method === "DELETE" && del) {
        return Number(del[1]) in Object.fromEntries([...failDelete].map((i) => [i, 1]))
          ? new Response("boom", { status: 500 })
          : new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
    session.token = undefined;
  });

  it("the caller is whoever the oracle names for the cookie, and nobody else", async () => {
    session.token = "good-token";
    expect(await resolveAccountCaller()).toEqual({ ok: true, userId: 7 });
    session.token = "revoked-token";
    expect(await resolveAccountCaller()).toMatchObject({ ok: false, status: 401 });
    session.token = undefined;
    expect(await resolveAccountCaller()).toMatchObject({ ok: false, status: 401 });
  });

  it("without the oracle there is no caller, rather than a guess from a display cookie", async () => {
    delete process.env.VEXA_INTERNAL_API_SECRET;
    session.token = "good-token";
    expect(await resolveAccountCaller()).toMatchObject({ ok: false, status: 503 });
  });

  it("revokes every dashboard-login token and only those", async () => {
    expect(await revokeAllLoginSessions(7)).toEqual({ ok: true, revoked: 2 });
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname);
    expect(deletes).toEqual(["/admin/tokens/10", "/admin/tokens/12"]);
  });

  it("a partial failure is reported as a failure, never as a complete sign-out", async () => {
    failDelete.add(12);
    expect(await revokeAllLoginSessions(7)).toMatchObject({ ok: false, status: 502, revoked: 1, failed: 1 });
  });

  it("an unreadable token list revokes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method || "GET" });
      return new Response("down", { status: 500 });
    }));
    expect(await revokeAllLoginSessions(7)).toMatchObject({ ok: false, revoked: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reads the profile, recorded door and sessions for the given user id", async () => {
    const out = await loadAccount(7);
    expect(out).toMatchObject({ ok: true, account: { name: "Me", email: "me@x.test", provider: { provider: "google", emailVerified: true } } });
    if (out.ok) expect(out.account.sessions).toHaveLength(2);
    expect(calls.map((c) => new URL(c.url).pathname).sort()).toEqual(["/admin/users/7", "/admin/users/7/tokens"]);
  });
});
