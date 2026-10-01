/** The browser end of the live feed against a scripted `fetch`: when it reports streaming, when it
 *  falls back to polling, and what it sends when it reconnects. */
import { describe, expect, it } from "vitest";
import { startLiveStream, type LiveMode } from "../liveStream";
import type { LiveEvent } from "../liveTranscript";

const enc = new TextEncoder();

/** A response whose body the test feeds by hand. */
function sseResponse(contentType = "text/event-stream") {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c; } });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": contentType } }),
    send: (text: string) => ctl.enqueue(enc.encode(text)),
    close: () => ctl.close(),
  };
}

function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error("timed out")); }
    }, 2);
  });
}

function harness(responses: Array<() => Response | Promise<Response>>, opts = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const modes: LiveMode[] = [];
  const events: Exclude<LiveEvent, { type: "meeting-end" }>[] = [];
  let ended = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const next = responses.shift();
    if (!next) return new Promise<Response>(() => {});
    return next();
  }) as unknown as typeof fetch;
  const stop = startLiveStream("/api/vexa/meetings/101/stream", {
    onEvent: (e) => events.push(e),
    onMode: (m) => modes.push(m),
    onEnded: () => { ended += 1; },
  }, { fetchImpl, reconnectMs: 5, unavailableMs: 20, maxUnavailableMs: 40, watchdogMs: 1000, ...opts });
  return { calls, modes, events, stop, ended: () => ended };
}

const TRANSCRIPT = (id: string, text: string) =>
  `data: ${JSON.stringify({ type: "transcript", speaker: "Amy", text, t: 1, tsMs: 1000, completed: true, id })}\n\n`;

describe("startLiveStream", () => {
  it("reports streaming on a 200 text/event-stream and delivers transcript events as they arrive", async () => {
    const s = sseResponse();
    const h = harness([() => s.response]);
    await until(() => h.modes.includes("streaming"));
    expect(h.calls[0]?.headers["Last-Event-ID"]).toBeUndefined();
    s.send("id: 1-0|$|0-0\n" + TRANSCRIPT("seg-1", "hello").slice(0, 20));
    s.send(TRANSCRIPT("seg-1", "hello").slice(20));
    await until(() => h.events.length === 1);
    expect(h.events[0]).toMatchObject({ type: "transcript", segment: { segment_id: "seg-1", text: "hello" } });
    h.stop();
  });

  it("reconnects after a drop with the last cursor as Last-Event-ID", async () => {
    const first = sseResponse();
    const second = sseResponse();
    const h = harness([() => first.response, () => second.response]);
    await until(() => h.modes.includes("streaming"));
    first.send("id: 7-0|$|0-0\n" + TRANSCRIPT("a", "one"));
    first.send(`id: 8-0|$|0-0\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
    await until(() => h.events.length === 1);
    first.close();
    await until(() => h.calls.length === 2);
    expect(h.modes).toContain("polling");
    expect(h.calls[1]?.headers["Last-Event-ID"]).toBe("8-0|$|0-0");
    h.stop();
  });

  it("treats a stream that ends without one event as unavailable: polls, retries on a backoff, sends no cursor", async () => {
    const refused = () => {
      const r = sseResponse();
      r.send('{"detail":"not authorized for this meeting"}');
      r.close();
      return r.response;
    };
    const h = harness([refused, refused, refused]);
    await until(() => h.calls.length === 3, 3000);
    expect(h.events).toEqual([]);
    expect(h.modes.filter((m) => m === "polling").length).toBeGreaterThanOrEqual(2);
    expect(h.calls.every((c) => c.headers["Last-Event-ID"] === undefined)).toBe(true);
    h.stop();
  });

  it("falls back to polling on a non-2xx answer or a body that is not an event stream", async () => {
    const h = harness([
      () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } }),
      () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    ]);
    await until(() => h.calls.length === 3, 3000);
    expect(h.modes).not.toContain("streaming");
    expect(h.modes).toContain("polling");
    h.stop();
  });

  it("falls back on a network failure", async () => {
    const h = harness([() => Promise.reject(new TypeError("fetch failed"))]);
    await until(() => h.modes.includes("polling"));
    h.stop();
  });

  it("stops for good on meeting-end and reports it once", async () => {
    const s = sseResponse();
    const h = harness([() => s.response]);
    await until(() => h.modes.includes("streaming"));
    s.send(`id: 2-0|$|0-0\ndata: ${JSON.stringify({ type: "meeting-end" })}\n\n`);
    await until(() => h.ended() === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.calls).toHaveLength(1);
    expect(h.modes).not.toContain("polling");
  });

  it("aborts a silent connection after the watchdog and reconnects", async () => {
    const first = sseResponse();
    const h = harness([() => first.response], { watchdogMs: 40 });
    await until(() => h.modes.includes("streaming"));
    first.send("id: 3-0|$|0-0\n" + TRANSCRIPT("a", "one"));
    await until(() => h.calls.length === 2, 2000);
    expect(h.calls[1]?.headers["Last-Event-ID"]).toBe("3-0|$|0-0");
    h.stop();
  });

  it("stop() aborts the open request and schedules nothing more", async () => {
    let signal: AbortSignal | undefined;
    const calls: number[] = [];
    const stop = startLiveStream("/x", { onEvent() {}, onMode() {}, onEnded() {} }, {
      fetchImpl: ((_: string, init?: RequestInit) => {
        calls.push(1);
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch,
      reconnectMs: 5,
      unavailableMs: 5,
    });
    await until(() => signal !== undefined);
    stop();
    expect(signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(1);
  });
});
