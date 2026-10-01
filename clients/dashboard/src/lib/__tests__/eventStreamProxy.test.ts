/** The streamed-write hop: chunks pass through as they arrive, a browser disconnect closes the
 *  upstream, and a refusal keeps its status instead of becoming an empty stream. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_STREAM_HEADERS, forwardEventStream, relayEventStream } from "../eventStreamProxy";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** An upstream body the test feeds by hand, recording whether it was cancelled. */
function manualUpstream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
    cancel() { state.cancelled = true; },
  });
  return { stream, state, push: (s: string) => ctrl.enqueue(enc.encode(s)), close: () => ctrl.close() };
}

describe("relayEventStream", () => {
  it("hands each upstream chunk downstream before the upstream has finished", async () => {
    const up = manualUpstream();
    const reader = relayEventStream(up.stream, new AbortController()).getReader();
    up.push("data: 1\n\n");
    expect(dec.decode((await reader.read()).value)).toBe("data: 1\n\n");
    up.push("data: 2\n\n");
    expect(dec.decode((await reader.read()).value)).toBe("data: 2\n\n");
    up.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("cancelling downstream aborts the upstream fetch and cancels the upstream body", async () => {
    const up = manualUpstream();
    const abort = new AbortController();
    const reader = relayEventStream(up.stream, abort).getReader();
    up.push("data: 1\n\n");
    await reader.read();
    await reader.cancel("browser went away");
    expect(abort.signal.aborted).toBe(true);
    expect(up.state.cancelled).toBe(true);
  });
});

describe("forwardEventStream", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the caller's key and body upstream and relays an event stream with only its own headers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream", "Set-Cookie": "x=1", "X-Unit-Id": "agent-u" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await forwardEventStream("http://gw/agent/chat", "tok", '{"prompt":"q"}', new AbortController().signal);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual(
      Object.fromEntries(Object.entries(EVENT_STREAM_HEADERS).map(([k, v]) => [k.toLowerCase(), v])),
    );
    expect(await res.text()).toBe("data: {}\n\n");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gw/agent/chat");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"prompt":"q"}');
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("tok");
  });

  it("aborts the upstream request when the browser's request aborts", async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Response(new ReadableStream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));
    const client = new AbortController();
    await forwardEventStream("http://gw/agent/chat", "tok", "{}", client.signal);
    expect(upstreamSignal?.aborted).toBe(false);
    client.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("passes a gateway refusal back as JSON with its own status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"detail":"Insufficient scope"}', { status: 403, headers: { "Content-Type": "application/json" } })));
    const res = await forwardEventStream("http://gw/agent/chat", "tok", "{}", new AbortController().signal);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ detail: "Insufficient scope" });
  });

  it("a 200 that is not an event stream is a 502, never relayed as one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    const res = await forwardEventStream("http://gw/agent/chat", "tok", "{}", new AbortController().signal);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "not_an_event_stream" });
  });

  it("an unreachable gateway is a 502 with a reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connect ECONNREFUSED"); }));
    const res = await forwardEventStream("http://gw/agent/chat", "tok", "{}", new AbortController().signal);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unreachable", detail: "connect ECONNREFUSED" });
  });
});
