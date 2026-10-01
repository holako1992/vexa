/** The browser end of the live transcript feed: one `fetch` reading `text/event-stream`, with the
 *  reconnect and fallback rules the meeting page relies on.
 *
 *  `fetch` rather than `EventSource` because this client must tell "the stream is unavailable"
 *  from "the stream dropped": `EventSource` hides the response status and reconnects on its own,
 *  and the gateway answers a refused stream (agent-api's 403/501) as a `200 text/event-stream`
 *  whose body is a JSON error with no SSE message in it. Reading the body ourselves makes that
 *  case observable — a stream that ends without one event was never available.
 *
 *  The rules:
 *   • `streaming` once a `200 text/event-stream` answer arrives; `polling` whenever it is not.
 *   • A stream that ended (or went silent past `watchdogMs`) after delivering events reconnects
 *     after `reconnectMs`, sending the last cursor as `Last-Event-ID` so nothing is skipped.
 *   • A stream that never delivered an event is unavailable; it is retried on a doubling backoff
 *     (`unavailableMs` up to `maxUnavailableMs`) while the page polls.
 *   • `meeting-end` stops the feed for good and reports `ended`.
 */
import { createSseParser, decodeLiveEvent, type LiveEvent } from "./liveTranscript";

export type LiveMode = "connecting" | "streaming" | "polling";

export interface LiveStreamHandlers {
  onEvent(event: Exclude<LiveEvent, { type: "meeting-end" }>): void;
  onMode(mode: LiveMode): void;
  onEnded(): void;
}

export interface LiveStreamOptions {
  fetchImpl?: typeof fetch;
  reconnectMs?: number;
  unavailableMs?: number;
  maxUnavailableMs?: number;
  /** No bytes for this long means the connection is dead even though it never closed. Above the
   *  producer's 15s idle ping. */
  watchdogMs?: number;
}

function isEventStream(res: Response): boolean {
  return (res.headers.get("content-type") || "").toLowerCase().startsWith("text/event-stream");
}

/** Open the feed at `url` and keep it open until the returned `stop` is called or the meeting
 *  ends. */
export function startLiveStream(url: string, handlers: LiveStreamHandlers, options: LiveStreamOptions = {}): () => void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const reconnectMs = options.reconnectMs ?? 1_000;
  const unavailableMs = options.unavailableMs ?? 15_000;
  const maxUnavailableMs = options.maxUnavailableMs ?? 120_000;
  const watchdogMs = options.watchdogMs ?? 45_000;

  let stopped = false;
  let lastEventId: string | undefined;
  let backoff = unavailableMs;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  async function connect(): Promise<void> {
    if (stopped) return;
    const abort = new AbortController();
    controller = abort;
    let delivered = false;
    let ended = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => abort.abort(), watchdogMs);
    };

    try {
      arm();
      const res = await fetchImpl(url, {
        headers: lastEventId ? { "Last-Event-ID": lastEventId, Accept: "text/event-stream" } : { Accept: "text/event-stream" },
        cache: "no-store",
        signal: abort.signal,
      });
      if (!res.ok || !res.body || !isEventStream(res)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`live stream unavailable (${res.status})`);
      }
      // Aborting (the watchdog, or `stop`) also ends a read already waiting on the body.
      const reader = res.body.getReader();
      abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      if (stopped) {
        await reader.cancel().catch(() => {});
        return;
      }
      handlers.onMode("streaming");

      const parser = createSseParser((msg) => {
        if (ended || stopped) return;
        if (msg.id !== undefined) lastEventId = msg.id;
        delivered = true;
        const event = decodeLiveEvent(msg.data);
        if (!event) return;
        if (event.type === "meeting-end") {
          ended = true;
          return;
        }
        handlers.onEvent(event);
      });
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        arm();
        parser.push(decoder.decode(value, { stream: true }));
        if (ended) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch {
      // Unreachable, refused, aborted by the watchdog or by `stop` — the decision below covers all.
    } finally {
      clearTimeout(watchdog);
      if (controller === abort) controller = null;
    }

    if (stopped) return;
    if (ended) {
      stopped = true;
      handlers.onEnded();
      return;
    }
    handlers.onMode("polling");
    let delay: number;
    if (delivered) {
      backoff = unavailableMs;
      delay = reconnectMs;
    } else {
      delay = backoff;
      backoff = Math.min(backoff * 2, maxUnavailableMs);
    }
    retryTimer = setTimeout(() => void connect(), delay);
  }

  handlers.onMode("connecting");
  void connect();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    controller?.abort();
  };
}
