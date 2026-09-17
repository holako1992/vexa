/** Every request enters here. Two jobs, in this order.
 *
 *  1. THE GATE. No page and no data route is reachable without a session cookie. A page request
 *     is redirected to /login (carrying where it was going); an /api/vexa/* request gets a 401
 *     JSON body, because a fetch caller cannot follow a login redirect meaningfully.
 *
 *     What this gate is, precisely: a coarse, cheap check that a session cookie EXISTS. It is not
 *     the authorization decision and must never be read as one — the token is authenticated by
 *     the gateway on every data call, and the identity oracle (lib/session.ts) verifies it at
 *     this edge where the deployment configures one. Running the oracle here, on every asset
 *     request, would put a network round-trip in front of every byte the app serves.
 *
 *  2. THE HEADERS. A per-response nonce and the CSP built around it (lib/security.ts), applied to
 *     the response the app produces — including redirects and errors, which is why it happens
 *     here rather than in a layout.
 */
import { NextResponse, type NextRequest } from "next/server";
import { makeNonce, securityHeaders, isSecureDeployment } from "@/lib/security";

const AUTH_COOKIE = process.env.VEXA_AUTH_COOKIE_NAME || "vexa-token";

/** Paths reachable without a session. Everything else needs one. */
function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/")
  );
}

export function middleware(req: NextRequest) {
  const nonce = makeNonce();
  const dev = process.env.NODE_ENV !== "production";
  const headers = securityHeaders(nonce, { dev, secure: isSecureDeployment() });

  const { pathname, search } = req.nextUrl;
  const authed = !!req.cookies.get(AUTH_COOKIE)?.value;

  const finish = (res: NextResponse) => {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  };

  if (!authed && !isPublic(pathname)) {
    if (pathname.startsWith("/api/")) {
      return finish(
        NextResponse.json({ error: "not_authenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } }),
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Only a same-site path is ever echoed back into `next`; the login page re-checks it before
    // navigating, so this can never become an open redirect.
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return finish(NextResponse.redirect(url));
  }

  // A signed-in visitor has no business on the login page.
  if (authed && pathname === "/login") {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return finish(NextResponse.redirect(url));
  }

  // The nonce travels to the app on a request header; Next reads it and stamps its own <script>
  // tags with it, which is what makes a nonce-based CSP work at all with the App Router.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]!);
  return finish(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  // Static assets under /_next/static are immutable and carry no session; skipping them keeps the
  // middleware off the hot path. Everything that can render or return data goes through.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
