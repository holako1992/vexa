import type { NextConfig } from "next";
import path from "path";

/**
 * Dashboard composition root.
 *
 * No rewrites: every backend call goes through the app's own `/api/vexa/*` route, which is a
 * closed allowlist (see src/app/api/vexa/[...path]/route.ts). A rewrite would be a second,
 * unguarded door to the gateway — the whole point of the proxy is that there is exactly one.
 *
 * `poweredByHeader: false` drops `X-Powered-By`; the remaining security headers are set per
 * request in src/middleware.ts, because the CSP carries a per-response nonce.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: path.resolve(__dirname) },
};

export default nextConfig;
