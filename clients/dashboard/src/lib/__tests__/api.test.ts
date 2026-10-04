/** `presentError` / `ApiError` — the fetch helper's failure surface. Weighted toward the shape
 * The `402 quota_exceeded` body actually has (unwrapped: `{"error": "quota_exceeded", ...}`,
 *  no `{"detail": ...}` envelope) versus the older `{"detail": "..."}` shape most other refusals
 *  still use, since a caller that only ever reads `detail` loses the quota fields entirely. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getJson, presentError } from "../api";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getJson — error body parsing", () => {
  it("captures the full unwrapped quota_exceeded body on ApiError, not just a squashed string", async () => {
    const body = { error: "quota_exceeded", limit: 1, used: 1, resets_at: "2026-10-01T00:00:00Z", upgrade_url: "https://pay.example/upgrade" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 402)));
    expect.assertions(3);
    try {
      await getJson("/api/vexa/bots");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(402);
      expect((e as ApiError).body).toEqual(body);
    }
  });

  it("still captures the older {detail} envelope's string", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "Meeting not found" }, 404)));
    expect.assertions(3);
    try {
      await getJson("/api/vexa/meetings/9");
    } catch (e) {
      expect((e as ApiError).status).toBe(404);
      expect((e as ApiError).detail).toBe("Meeting not found");
      expect((e as ApiError).body).toEqual({ detail: "Meeting not found" });
    }
  });
});

describe("presentError — quota_exceeded (402)", () => {
  it("surfaces a reset date from the unwrapped quota_exceeded body", () => {
    const e = new ApiError(402, "quota_exceeded", "/api/vexa/bots", {
      error: "quota_exceeded", limit: 1, used: 1, resets_at: "2026-10-01T00:00:00Z", upgrade_url: null,
    });
    const msg = presentError(e);
    expect(msg).toContain("allowance");
    expect(msg).toContain("Resets 1 October");
  });

  it("states the fixed reason copy for identity_unverified, and ignores an unknown reason", () => {
    const base = { error: "quota_exceeded", limit: 0, used: 0, resets_at: "2026-10-01T00:00:00Z", upgrade_url: null };
    const known = presentError(new ApiError(402, "quota_exceeded", "/api/vexa/bots", { ...base, reason: "identity_unverified" }));
    expect(known).toContain("isn't verified");
    const unknown = presentError(new ApiError(402, "quota_exceeded", "/api/vexa/bots", { ...base, reason: "<b>x</b>" }));
    expect(unknown).not.toContain("<b>");
    expect(unknown).toContain("allowance");
  });

  it("falls back to a generic 402 message when the body isn't the quota_exceeded shape", () => {
    const e = new ApiError(402, "", "/api/vexa/bots", { detail: "some other reason" });
    expect(presentError(e)).toBe("Payment required.");
  });

  it("falls back to a generic 402 message with no body at all", () => {
    const e = new ApiError(402, "", "/api/vexa/bots");
    expect(presentError(e)).toBe("Payment required.");
  });
});

describe("presentError — the plain {detail} envelope", () => {
  it("still renders the status-keyed sentence regardless of detail content", () => {
    const e = new ApiError(404, "Meeting not found", "/api/vexa/meetings/9", { detail: "Meeting not found" });
    expect(presentError(e)).toBe("Not found.");
  });

  it("network failure (status 0) and non-ApiError values still resolve", () => {
    expect(presentError(new ApiError(0, "network error", "/api/vexa/meetings"))).toContain("Couldn't reach");
    expect(presentError(new Error("boom"))).toContain("Something went wrong");
  });
});

describe("presentError — 502", () => {
  it("shows Stripe's reason when the core says Stripe refused", () => {
    const body = { error: "stripe_refused", detail: "Stripe refused the request: No such customer: 'cus_x'" };
    expect(presentError(new ApiError(502, body.detail, "/api/vexa/billing/checkout", body))).toBe(
      "Stripe refused the request: No such customer: 'cus_x'",
    );
  });

  it("still reports an unreachable upstream as unreachable", () => {
    const body = { error: "upstream_unreachable", detail: "fetch failed" };
    expect(presentError(new ApiError(502, "fetch failed", "/api/vexa/billing/checkout", body))).toBe(
      "The Vexa backend is unreachable right now.",
    );
    expect(presentError(new ApiError(502, "", "/api/vexa/x"))).toBe("The Vexa backend is unreachable right now.");
  });
});
