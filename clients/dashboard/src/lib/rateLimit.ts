/** A fixed-window rate limiter for the app's own credential endpoints.
 *
 *  SCOPE, stated honestly: this is per-process, in-memory state. It bounds a single instance and
 *  is reset by a restart; it is not a cluster-wide limit and must not be mistaken for one. It
 *  exists because the login route can create a user and mint a token, and an unbounded loop on
 *  that is worth stopping at the cheapest layer that can see it. A multi-instance deployment
 *  puts the real limit at the ingress.
 */

interface Window { count: number; resetAt: number }

const windows = new Map<string, Window>();

/** Drop expired windows so a long-lived process doesn't accumulate one entry per client seen. */
function sweep(now: number): void {
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}

export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

/** Count one hit against `key`. Allows up to `limit` hits per `windowMs`. */
export function hit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (windows.size > 4096) sweep(now);
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  w.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
  if (w.count > limit) return { allowed: false, remaining: 0, retryAfterSeconds };
  return { allowed: true, remaining: limit - w.count, retryAfterSeconds };
}

/** Test seam — drops all counters. */
export function resetRateLimits(): void {
  windows.clear();
}

/** The caller's address for limiting purposes.
 *
 *  `X-Forwarded-For` is client-spoofable, so it is trusted ONLY when the deployment declares it
 *  is behind a proxy (DASHBOARD_TRUST_PROXY=true). Otherwise every request shares the "direct"
 *  bucket, which is strict rather than wrong: a misconfigured deployment throttles too much, it
 *  never throttles too little.
 */
export function clientKey(headers: { get(name: string): string | null }): string {
  if (process.env.DASHBOARD_TRUST_PROXY === "true") {
    const fwd = headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim() || "direct";
    const real = headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return "direct";
}
