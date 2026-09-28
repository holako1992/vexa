/** The ONE non-JSON hop this proxy makes: the recording media byte stream (DB-50,
 *  `.../recordings/<id>/media/<id>/raw` and its `.../download` alias, both marked `raw: true` in
 *  `upstream.ts`). Everywhere else `route.ts` forwards `Accept: application/json` and parses the
 *  upstream body; this route forwards audio/video bytes instead, so the request and response
 *  header handling is different enough to pull out as its own pair of pure functions — testable
 *  without a running Next.js request/response, the same reason `filterQuery` lives in
 *  `upstream.ts` rather than inline in the route.
 */

/** The exact request headers this proxy sends the gateway for the raw byte-stream route: the
 *  caller's own `Range` header, verbatim, when present — and NOTHING else off the incoming
 *  request. This is the one route where a client header rides past the API key at all (playback
 *  and seek do not work without it, `docs/docs/how-to/recordings.mdx`); every other client
 *  header — cookies, user-agent, accept-language, whatever a browser sends — stops here the same
 *  as it does for every JSON route this proxy forwards. `null`/empty means the browser asked for
 *  the whole file, so nothing is added. */
export function rawRequestHeaders(rangeHeader: string | null | undefined): Record<string, string> {
  return rangeHeader ? { Range: rangeHeader } : {};
}

/** The upstream response headers copied back to the browser for the raw byte-stream route — the
 *  ones a `<audio>`/`<video>` element's Range/seek machinery actually reads, nothing else (never
 *  a `Set-Cookie`, an internal trace header, or anything else the gateway hop happened to add).
 *  `content-length` is copied through rather than recomputed because the body is STREAMED
 *  (`route.ts` never buffers it into memory to measure it); `content-type`/`content-range`/
 *  `accept-ranges` are what make a `206 Partial Content` a valid one. `Cache-Control: no-store`
 *  is added unconditionally, same as every other route this proxy serves — a signed-in-only
 *  recording is never something a shared cache should hold. */
const COPIED_RESPONSE_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

/** Media types the byte stream may carry. Anything else is served as an opaque download, so an
 *  upstream answer can never render as a document on the dashboard's own origin. */
const MEDIA_TYPE = /^(audio|video)\/[a-z0-9.+-]+(\s*;.*)?$/i;

export function rawResponseHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  for (const key of COPIED_RESPONSE_HEADERS) {
    const value = upstream.get(key);
    if (value != null) out[key] = value;
  }
  if (out["content-type"] !== undefined && !MEDIA_TYPE.test(out["content-type"])) {
    out["content-type"] = "application/octet-stream";
  }
  return out;
}
