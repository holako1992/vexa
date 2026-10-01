/** The proxy's server-sent-events hop: the live transcript feed (`route.sse` in `upstream.ts`).
 *
 *  An SSE answer never ends on its own while a meeting runs, so this hop must stream, never
 *  buffer: the gateway's body is pumped chunk by chunk into the browser's response. Three more
 *  properties make it a faithful passthrough:
 *
 *   • `Last-Event-ID` is the one client header forwarded, and only when it has the producer's own
 *     cursor shape (`isLiveCursor`) — the core resumes from it, so it reaches the core untouched
 *     or not at all.
 *   • The answer is marked `no-cache, no-store, no-transform` with `X-Accel-Buffering: no`, so no
 *     cache, compressor or reverse proxy between here and the browser holds bytes back.
 *   • When the browser goes away, the upstream request is aborted, so no gateway connection
 *     outlives its reader.
 *
 *  A non-2xx gateway answer is passed through with its own status as a JSON body; a 2xx that is
 *  not `text/event-stream` is a 502 — the browser is never handed something else as a stream.
 */
import { isLiveCursor } from "./liveTranscript";

export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
};

/** The request headers sent upstream for an SSE route, beyond the API key: `Accept`, and the
 *  caller's `Last-Event-ID` only when it is a well-formed cursor. */
export function sseRequestHeaders(lastEventId: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (isLiveCursor(lastEventId)) headers["Last-Event-ID"] = lastEventId;
  return headers;
}

/** The first bytes of every proxied stream: an SSE comment, which every reader ignores. The server
 *  sends a response head only with its first body chunk, and the producer may say nothing for its
 *  whole idle-ping interval, so without this the browser would wait that long to learn the stream
 *  is open. */
export const SSE_OPENING = ": connected\n\n";

/** Copy `upstream` into a fresh stream the caller owns: `SSE_OPENING` first, then every chunk as
 *  it arrives. An upstream end or failure ends it — either way the browser sees the stream close
 *  and reconnects with its cursor — and the browser cancelling it aborts `abort`. */
export function pumpStream(upstream: ReadableStream<Uint8Array>, abort: AbortController): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(SSE_OPENING));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        abort.abort();
        controller.close();
      }
    },
    cancel(reason) {
      abort.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

const HEADERS_TIMEOUT_MS = 20_000;

/** Forward one SSE request to `url` with the user's `token`. `clientSignal` is the browser
 *  request's own signal; `lastEventId` its `Last-Event-ID` header. */
export async function forwardSse(
  url: string,
  token: string,
  lastEventId: string | null,
  clientSignal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const abort = new AbortController();
  const onClientGone = () => abort.abort();
  clientSignal.addEventListener("abort", onClientGone, { once: true });
  // Bounds the wait for the response head only; the body runs as long as the meeting does.
  const timer = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);
  const jsonError = (body: unknown, status: number) => {
    clientSignal.removeEventListener("abort", onClientGone);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  };

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: "GET",
      headers: { "X-API-Key": token, ...sseRequestHeaders(lastEventId) },
      cache: "no-store",
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const detail = err instanceof Error && err.message ? err.message : "upstream unreachable";
    return jsonError({ error: "upstream_unreachable", detail }, 502);
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : { error: "upstream_error" };
    } catch {
      body = { error: "upstream_error", detail: text.slice(0, 500) };
    }
    return jsonError(body, upstream.status);
  }
  const type = (upstream.headers.get("content-type") || "").toLowerCase();
  if (!upstream.body || !type.startsWith("text/event-stream")) {
    await upstream.body?.cancel().catch(() => {});
    abort.abort();
    return jsonError({ error: "not_event_stream" }, 502);
  }
  return new Response(pumpStream(upstream.body, abort), { status: 200, headers: SSE_RESPONSE_HEADERS });
}
