/** The security posture is policy, and policy that isn't asserted drifts. These tests pin the
 *  properties an operator is entitled to rely on. */
import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  isSameOriginWrite,
  isTrustedBillingRedirect,
  makeNonce,
  safeNext,
  securityHeaders,
} from "../security";
import { hit, resetRateLimits } from "../rateLimit";

describe("contentSecurityPolicy", () => {
  it("nonces scripts and never allows unsafe-inline for them", () => {
    const csp = contentSecurityPolicy("abc123", false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("keeps eval and the HMR socket out of a production policy", () => {
    const prod = contentSecurityPolicy("n", false);
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).toContain("connect-src 'self'");
    expect(contentSecurityPolicy("n", true)).toContain("unsafe-eval");
  });

  it("closes framing, objects and off-origin form posts", () => {
    const csp = contentSecurityPolicy("n", false);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
  });
});

describe("securityHeaders", () => {
  it("sends HSTS only on an HTTPS deployment", () => {
    expect(securityHeaders("n", { dev: false, secure: false })["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders("n", { dev: false, secure: true })["Strict-Transport-Security"]).toContain("max-age=");
  });

  it("always sends the sniffing, framing and referrer guards", () => {
    const h = securityHeaders("n", { dev: true, secure: false });
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
});

describe("makeNonce", () => {
  it("is unique per call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeNonce()));
    expect(seen.size).toBe(50);
  });
});

describe("isSameOriginWrite", () => {
  const req = (headers: Record<string, string>) => ({
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  });

  it("admits a same-origin post and refuses a cross-origin one", () => {
    expect(isSameOriginWrite(req({ origin: "https://vexa.example.com", host: "vexa.example.com" }))).toBe(true);
    expect(isSameOriginWrite(req({ origin: "https://evil.example.com", host: "vexa.example.com" }))).toBe(false);
  });

  it("admits a request with no Origin — it carries no other site's ambient authority", () => {
    expect(isSameOriginWrite(req({ host: "vexa.example.com" }))).toBe(true);
  });

  it("refuses a malformed Origin rather than guessing", () => {
    expect(isSameOriginWrite(req({ origin: "not a url", host: "vexa.example.com" }))).toBe(false);
  });
});

describe("rate limit", () => {
  it("allows up to the limit inside the window, then refuses with a retry hint", () => {
    resetRateLimits();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) expect(hit("k", 5, 60_000, now).allowed).toBe(true);
    const blocked = hit("k", 5, 60_000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("opens again once the window rolls over", () => {
    resetRateLimits();
    expect(hit("k", 1, 60_000, 1_000_000).allowed).toBe(true);
    expect(hit("k", 1, 60_000, 1_000_000).allowed).toBe(false);
    expect(hit("k", 1, 60_000, 1_061_000).allowed).toBe(true);
  });

  it("counts each caller separately", () => {
    resetRateLimits();
    expect(hit("a", 1, 60_000, 1).allowed).toBe(true);
    expect(hit("b", 1, 60_000, 1).allowed).toBe(true);
  });
});

describe("safeNext", () => {
  it("keeps a same-site path", () => {
    expect(safeNext("/meetings/42")).toBe("/meetings/42");
  });

  it("collapses every off-origin shape to the root", () => {
    for (const bad of ["//evil.example.com", "/\\evil.example.com", "https://evil.example.com", "evil", null, ""]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});

describe("isTrustedBillingRedirect (DB-74b)", () => {
  it("admits Stripe's own Checkout and Portal hosts, over https", () => {
    expect(isTrustedBillingRedirect("https://checkout.stripe.com/c/pay/cs_test_abc")).toBe(true);
    expect(isTrustedBillingRedirect("https://billing.stripe.com/p/session/xyz")).toBe(true);
  });

  it("refuses a plausible-looking near-miss host", () => {
    for (const bad of [
      "https://checkout.stripe.com.evil.example.com/x",
      "https://evil.example.com/checkout.stripe.com",
      "https://stripe.com/x",
      "https://checkout-stripe.com/x",
      "https://xn--checkout-stripecom.evil.test/x",
    ]) {
      expect(isTrustedBillingRedirect(bad)).toBe(false);
    }
  });

  it("refuses a non-https scheme on an otherwise-trusted host", () => {
    expect(isTrustedBillingRedirect("http://checkout.stripe.com/c/pay/cs_test_abc")).toBe(false);
    expect(isTrustedBillingRedirect("javascript://checkout.stripe.com/%0aalert(1)")).toBe(false);
  });

  it("refuses a malformed or non-URL string outright", () => {
    for (const bad of ["", "not a url", "checkout.stripe.com", "//checkout.stripe.com/x"]) {
      expect(isTrustedBillingRedirect(bad)).toBe(false);
    }
  });
});
