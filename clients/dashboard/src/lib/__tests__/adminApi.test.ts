/** What the dashboard sends to admin-api on sign-up, and what it makes of a refusal. `fetch` is
 *  replaced with a recorder, so these assert the exact outgoing headers and the typed failure. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findOrCreateUserToken, forwardedForHeader } from "../adminApi";
import { clientAddress, clientKey } from "../rateLimit";

const headersOf = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("clientAddress / clientKey", () => {
  const original = process.env.DASHBOARD_TRUST_PROXY;
  afterEach(() => {
    if (original === undefined) delete process.env.DASHBOARD_TRUST_PROXY;
    else process.env.DASHBOARD_TRUST_PROXY = original;
  });

  it("with trust-proxy off, a client-supplied X-Forwarded-For is never an address", () => {
    delete process.env.DASHBOARD_TRUST_PROXY;
    const h = headersOf({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.10" });
    expect(clientAddress(h)).toBeNull();
    expect(clientKey(h)).toBe("direct");
  });

  it("with trust-proxy on, the first X-Forwarded-For hop wins, then X-Real-IP, else null", () => {
    process.env.DASHBOARD_TRUST_PROXY = "true";
    expect(clientAddress(headersOf({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientAddress(headersOf({ "x-real-ip": "203.0.113.10" }))).toBe("203.0.113.10");
    expect(clientAddress(headersOf({}))).toBeNull();
    expect(clientKey(headersOf({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientKey(headersOf({}))).toBe("direct");
  });
});

describe("forwardedForHeader", () => {
  it("sends a plain IPv4 or IPv6 address", () => {
    expect(forwardedForHeader("203.0.113.9")).toEqual({ "X-Forwarded-For": "203.0.113.9" });
    expect(forwardedForHeader("2001:db8::1")).toEqual({ "X-Forwarded-For": "2001:db8::1" });
  });

  it("sends nothing when the address is unknown or is not an address", () => {
    expect(forwardedForHeader(null)).toEqual({});
    expect(forwardedForHeader(undefined)).toEqual({});
    expect(forwardedForHeader("")).toEqual({});
    expect(forwardedForHeader("unknown")).toEqual({});
    expect(forwardedForHeader("1.2.3.4, 5.6.7.8")).toEqual({});
    expect(forwardedForHeader("1.2.3.4\r\nX-Admin-API-Key: x")).toEqual({});
  });
});

describe("findOrCreateUserToken", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let responder: (url: string, init: RequestInit) => Response;

  beforeEach(() => {
    process.env.VEXA_ADMIN_API_URL = "http://admin.test";
    process.env.VEXA_ADMIN_API_KEY = "test-admin-key";
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responder(url, init);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const happyPath = (url: string, init: RequestInit) => {
    if (url.includes("/admin/users/email/")) return json(404, {});
    if (url.endsWith("/admin/users") && init.method === "POST") return json(201, { id: 7, email: "a@b.co" });
    if (url.includes("/tokens") && init.method === "POST") return json(200, { id: 1, token: "tok" });
    return json(200, []);
  };

  it("forwards the client address on the create call, and only there", async () => {
    responder = happyPath;
    const r = await findOrCreateUserToken("a@b.co", "203.0.113.9");
    expect(r.ok).toBe(true);
    const create = calls.find((c) => c.url.endsWith("/admin/users"))!;
    expect((create.init.headers as Record<string, string>)["X-Forwarded-For"]).toBe("203.0.113.9");
    expect((create.init.headers as Record<string, string>)["X-Admin-API-Key"]).toBe("test-admin-key");
    for (const c of calls.filter((c) => c !== create)) {
      expect((c.init.headers as Record<string, string>)["X-Forwarded-For"]).toBeUndefined();
    }
  });

  it("sends no X-Forwarded-For when the address is unknown", async () => {
    responder = happyPath;
    await findOrCreateUserToken("a@b.co", null);
    const create = calls.find((c) => c.url.endsWith("/admin/users"))!;
    expect(Object.keys(create.init.headers as object).map((k) => k.toLowerCase())).not.toContain("x-forwarded-for");
  });

  it("returns a typed disposable-domain refusal from admin-api's 422", async () => {
    responder = (url) =>
      url.includes("/admin/users/email/")
        ? json(404, {})
        : json(422, { detail: { error: "disposable_email_domain", message: "no" } });
    const r = await findOrCreateUserToken("x@mailinator.com", "203.0.113.9");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.refusal.code).toBe("disposable_email_domain");
    }
  });

  const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));

  it("sends the provenance on the create call for a new account", async () => {
    responder = happyPath;
    await findOrCreateUserToken("a@b.co", null, { provider: "google", emailVerified: true });
    const create = calls.find((c) => c.url.endsWith("/admin/users") && c.init.method === "POST")!;
    expect(body(create)).toEqual({ email: "a@b.co", identity_provider: "google", email_verified: true });
  });

  it("sends an unverified provenance on create, and nothing when there is no provenance", async () => {
    responder = happyPath;
    await findOrCreateUserToken("a@b.co", null, { provider: "email", emailVerified: false });
    expect(body(calls.find((c) => c.url.endsWith("/admin/users"))!)).toEqual({
      email: "a@b.co", identity_provider: "email", email_verified: false,
    });
    calls.length = 0;
    await findOrCreateUserToken("a@b.co");
    expect(body(calls.find((c) => c.url.endsWith("/admin/users"))!)).toEqual({ email: "a@b.co" });
  });

  const existing = (url: string, init: RequestInit) => {
    if (url.includes("/admin/users/email/")) return json(200, { id: 7, email: "a@b.co" });
    if (url.includes("/tokens") && init.method === "POST") return json(200, { id: 1, token: "tok" });
    return json(200, {});
  };

  it("upgrades an existing account with a verified provenance via PATCH, and does not create", async () => {
    responder = existing;
    const r = await findOrCreateUserToken("a@b.co", null, { provider: "microsoft", emailVerified: true });
    expect(r.ok).toBe(true);
    const patch = calls.find((c) => c.init.method === "PATCH")!;
    expect(patch.url).toBe("http://admin.test/admin/users/7");
    expect(body(patch)).toEqual({ identity_provider: "microsoft", email_verified: true });
    expect(calls.some((c) => c.url.endsWith("/admin/users") && c.init.method === "POST")).toBe(false);
  });

  it("never sends an unverified claim for an existing account", async () => {
    responder = existing;
    const r = await findOrCreateUserToken("a@b.co", null, { provider: "email", emailVerified: false });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.init.method === "PATCH")).toBe(false);
  });

  it("a failed provenance upgrade does not fail the sign-in", async () => {
    responder = (url, init) => (init.method === "PATCH" ? json(500, { detail: "boom" }) : existing(url, init));
    const r = await findOrCreateUserToken("a@b.co", null, { provider: "google", emailVerified: true });
    expect(r.ok).toBe(true);
  });

  it("returns unavailable when admin-api is down", async () => {
    responder = () => json(503, { detail: "down" });
    const r = await findOrCreateUserToken("a@b.co");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("unavailable");
  });
});
