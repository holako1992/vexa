/** The dashboard's HTTP security posture, in one place.
 *
 *  Every response leaves through src/middleware.ts, which calls `securityHeaders()` with a
 *  freshly generated nonce. Keeping the policy here (rather than in next.config's static
 *  `headers()`) is what lets the CSP carry that per-response nonce: a static header can only
 *  ship `'unsafe-inline'`, which is not a script policy at all.
 *
 *  The policy is deliberately narrow because the dashboard's whole network surface is
 *  same-origin: the browser talks to `/api/vexa/*` and `/api/auth/*` and nothing else — the
 *  gateway host and the API key never reach the client. `connect-src 'self'` therefore costs
 *  nothing and closes exfiltration through fetch/XHR/WebSocket.
 */

/** A base64 nonce for the CSP + the `<script nonce>` Next.js emits. 16 bytes of CSPRNG. */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Build the Content-Security-Policy value.
 *
 *  `dev` relaxes exactly two things, both of which are development-toolchain facts rather than
 *  choices: Next's dev bundler evaluates generated code (`'unsafe-eval'`) and its HMR client
 *  opens a websocket back to the dev server (`ws:`). A production build needs neither, so the
 *  production policy has neither.
 *
 *  `style-src` keeps `'unsafe-inline'`: Next injects the compiled Tailwind stylesheet inline in
 *  development and emits inline `<style>` for streamed segments in production. Inline STYLE is
 *  not script execution — it is the one relaxation this app accepts, and it is scoped to styles.
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  const script = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`, ...(dev ? [`'unsafe-eval'`] : [])];
  const connect = [`'self'`, ...(dev ? ["ws:"] : [])];
  return [
    `default-src 'self'`,
    `script-src ${script.join(" ")}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src ${connect.join(" ")}`,
    // The dashboard renders nothing from a third party and embeds nothing: every framing
    // direction is closed, which is also the clickjacking answer.
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    // Forms post only to this origin (the login route). An injected form cannot exfiltrate.
    `form-action 'self'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}

/** The full header set for one response. `secure` (an HTTPS deployment) adds HSTS — sending it
 *  over plain HTTP is both ignored and misleading, so it is conditional, not constant. */
export function securityHeaders(nonce: string, opts: { dev: boolean; secure: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(nonce, opts.dev),
    "X-Content-Type-Options": "nosniff",
    // Redundant with `frame-ancestors` for modern browsers, kept for the ones that only know this.
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // The dashboard asks for no device capability. Denying them means a compromised dependency
    // cannot ask either.
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
  };
  if (opts.secure) headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  return headers;
}

/** Is this deployment served over HTTPS? Read from the declared public origin, never from a
 *  request header — `X-Forwarded-Proto` is client-settable and would let a plain-HTTP caller
 *  flip the cookie flags. */
export function isSecureDeployment(): boolean {
  return (
    (process.env.DASHBOARD_URL || "").startsWith("https://") ||
    (process.env.NEXTAUTH_URL || "").startsWith("https://")
  );
}

/** Cross-origin write guard for the app's own POST routes (NextAuth brings its own CSRF token).
 *
 *  SameSite=Lax cookies already stop a cross-site POST from carrying the session, so this is the
 *  second layer: a request whose `Origin` is present and is NOT this host is refused outright.
 *  A missing Origin (same-origin navigation in older engines, server-to-server curl) is allowed —
 *  it carries no ambient cookie authority from another site, which is the threat being closed.
 */
export function isSameOriginWrite(req: { headers: { get(name: string): string | null } }): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Is a post-login redirect target safe to navigate to?
 *
 *  Only a path on this site qualifies: one leading slash, and not `//host` or `/\host`, both of
 *  which browsers read as protocol-relative — i.e. another origin. Anything else collapses to `/`,
 *  which is what keeps the `next` query parameter from becoming an open redirect.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

/** The exact hosts Stripe serves Checkout Sessions and Customer Portal sessions from
 *  (`stripe_gateway.py`'s `create_checkout_session`/`create_portal_session` — both real Stripe
 *  API calls, never mocked in production). */
const STRIPE_REDIRECT_HOSTS = new Set(["checkout.stripe.com", "billing.stripe.com"]);

/** Is a `{url}` from `POST /billing/checkout` or `POST /billing/portal` safe to send the browser
 *  to with `window.location.assign()`?
 *
 *  `safeNext()` above answers the opposite question (is this INTERNAL) — this one exists because
 *  billing's whole point is an EXTERNAL redirect, to Stripe's own hosted UI. admin-api's
 *  `CheckoutResponse`/`PortalResponse` are typed as `url: str` with no shape check of their own
 *  (`main.py`), and that URL is Stripe's `session["url"]` verbatim — trusted in the ordinary case,
 *  but this client still checks it before navigating rather than assuming a 200 body is safe to
 *  hand a full-page redirect to. A malformed response, a misbehaving upstream, or a future
 *  regression that returns the wrong field all fail closed here instead of taking the signed-in
 *  user's browser to an arbitrary origin. */
export function isTrustedBillingRedirect(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && STRIPE_REDIRECT_HOSTS.has(parsed.hostname);
}
