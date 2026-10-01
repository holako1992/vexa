/** The proxy hop for a streamed write: `POST /agent/chat` (`eventStream: true` in `upstream.ts`).
 *
 *  Every other write `route.ts` forwards is request/response JSON under a 20 s timeout. A chat
 *  turn is a `text/event-stream` that stays open for as long as the agent thinks, so it gets its
 *  own hop with three properties:
 *
 *   - Not buffered: each upstream chunk is handed to the browser as it arrives (`relayEventStream`
 *     pulls one chunk per downstream read), so the answer renders word by word.
 *   - Closed from both ends: when the browser goes away (Stop, navigation, a closed tab) the
 *     downstream is cancelled, and that aborts the upstream fetch, so the gateway sees the
 *     disconnect instead of holding an orphaned connection to agent-api open.
 *   - Honest about refusals: an upstream answer that is not an event stream (the gateway's own
 *     `401`/`403`/`404`, a `502`) is passed back as JSON with its status unchanged.
 *
 *  Only the response headers named in `EVENT_STREAM_HEADERS` reach the browser.
 */

export const EVENT_STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
} as const;

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

/** How long to wait for the upstream's response headers. The gateway answers the headers of a
 *  chat stream at once; the body may then run for minutes, which this does not bound. */
const HEADERS_TIMEOUT_MS = 30_000;

/** Re-emit `upstream` chunk by chunk. Cancelling the returned stream aborts `upstreamAbort` and
 *  cancels the upstream reader; an upstream read error errors the returned stream. */
export function relayEventStream(
  upstream: ReadableStream<Uint8Array>,
  upstreamAbort: AbortController,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      upstreamAbort.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

function isEventStream(contentType: string | null): boolean {
  return !!contentType && contentType.split(";")[0]!.trim().toLowerCase() === "text/event-stream";
}

/** POST `body` to `url` with the caller's key and stream the answer back. `clientSignal` is the
 *  browser request's own signal: when it aborts, so does the upstream fetch. */
export async function forwardEventStream(
  url: string,
  token: string,
  body: string,
  clientSignal: AbortSignal,
): Promise<Response> {
  const upstreamAbort = new AbortController();
  const onClientGone = () => upstreamAbort.abort();
  if (clientSignal.aborted) upstreamAbort.abort();
  else clientSignal.addEventListener("abort", onClientGone, { once: true });
  const timer = setTimeout(() => upstreamAbort.abort(), HEADERS_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-Key": token,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
      cache: "no-store",
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    clientSignal.removeEventListener("abort", onClientGone);
    const detail = err instanceof Error && err.message ? err.message : "upstream unreachable";
    return new Response(JSON.stringify({ error: "upstream_unreachable", detail }), { status: 502, headers: JSON_HEADERS });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok || !isEventStream(upstream.headers.get("content-type")) || !upstream.body) {
    clientSignal.removeEventListener("abort", onClientGone);
    const text = await upstream.text().catch(() => "");
    const status = upstream.ok ? 502 : upstream.status;
    const payload = upstream.ok ? JSON.stringify({ error: "not_an_event_stream" }) : text || JSON.stringify({ error: "upstream_error" });
    return new Response(payload, { status, headers: JSON_HEADERS });
  }
  return new Response(relayEventStream(upstream.body, upstreamAbort), { status: 200, headers: EVENT_STREAM_HEADERS });
}
