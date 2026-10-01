/** The proxy's SSE hop against a scripted gateway: what it forwards, that it streams rather than
 *  buffers, and that the browser leaving tears the upstream down. */
import { describe, expect, it } from "vitest";
import { SSE_OPENING, SSE_RESPONSE_HEADERS, forwardSse, sseRequestHeaders } from "../sseProxy";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("sseRequestHeaders", () => {
  it("forwards a well-formed cursor and nothing else off the client", () => {
    expect(sseRequestHeaders("12-0|$|0-0")).toEqual({ Accept: "text/event-stream", "Last-Event-ID": "12-0|$|0-0" });
    expect(sseRequestHeaders(null)).toEqual({ Accept: "text/event-stream" });
  });

  it("drops a malformed Last-Event-ID rather than forwarding it", () => {
    for (const v of ["", "garbage", "1-0|$\r\nX-User-Id: 1", "1|2", "1-0|$|0-0|9-9"]) {
      expect(sseRequestHeaders(v)).toEqual({ Accept: "text/event-stream" });
    }
  });
});

function gateway(response: () => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("forwardSse", () => {
  it("sends the key, Accept and the cursor, and answers with no-cache SSE headers", async () => {
    const g = gateway(() => new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
    const res = await forwardSse("http://gw/agent/meeting/stream?meeting_id=1&session_uid=1", "tok", "3-0|$|0-0", new AbortController().signal, g.fetchImpl);
    expect(g.seen[0]?.init.headers).toEqual({ "X-API-Key": "tok", Accept: "text/event-stream", "Last-Event-ID": "3-0|$|0-0" });
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(SSE_RESPONSE_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(await res.text()).toBe(`${SSE_OPENING}data: {}\n\n`);
  });

  it("opens with an SSE comment, then streams each chunk before the upstream has finished", async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c; } });
    const g = gateway(() => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const res = await forwardSse("http://gw/s", "tok", null, new AbortController().signal, g.fetchImpl);
    const reader = res.body!.getReader();
    expect(dec.decode((await reader.read()).value)).toBe(SSE_OPENING);
    expect(SSE_OPENING.startsWith(":")).toBe(true);
    ctl.enqueue(enc.encode("data: first\n\n"));
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe("data: first\n\n");
    ctl.enqueue(enc.encode("data: second\n\n"));
    expect(dec.decode((await reader.read()).value)).toBe("data: second\n\n");
    ctl.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("ends the browser's stream when the upstream fails mid-stream", async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c; } });
    const g = gateway(() => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const res = await forwardSse("http://gw/s", "tok", null, new AbortController().signal, g.fetchImpl);
    const reader = res.body!.getReader();
    await reader.read(); // the opening comment
    ctl.enqueue(enc.encode("data: one\n\n"));
    expect(dec.decode((await reader.read()).value)).toBe("data: one\n\n");
    ctl.error(new TypeError("terminated"));
    expect((await reader.read()).done).toBe(true);
    expect(g.seen[0]!.init.signal!.aborted).toBe(true);
  });

  it("aborts the upstream request when the browser goes away", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const g = gateway(() => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const client = new AbortController();
    const res = await forwardSse("http://gw/s", "tok", null, client.signal, g.fetchImpl);
    const upstreamSignal = g.seen[0]!.init.signal!;
    expect(upstreamSignal.aborted).toBe(false);
    client.abort();
    expect(upstreamSignal.aborted).toBe(true);
    await res.body!.cancel();
  });

  it("aborts the upstream request when the response stream is cancelled", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const g = gateway(() => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const res = await forwardSse("http://gw/s", "tok", null, new AbortController().signal, g.fetchImpl);
    await res.body!.cancel();
    expect(g.seen[0]!.init.signal!.aborted).toBe(true);
  });

  it("passes a gateway refusal through with its own status as JSON", async () => {
    const g = gateway(() => new Response(JSON.stringify({ detail: "Insufficient scope" }), { status: 403 }));
    const res = await forwardSse("http://gw/s", "tok", null, new AbortController().signal, g.fetchImpl);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ detail: "Insufficient scope" });
  });

  it("refuses to hand a non-SSE 200 to the browser as a stream", async () => {
    const g = gateway(() => new Response("<html>", { headers: { "Content-Type": "text/html" } }));
    const res = await forwardSse("http://gw/s", "tok", null, new AbortController().signal, g.fetchImpl);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "not_event_stream" });
  });

  it("answers 502 when the gateway is unreachable", async () => {
    const g = gateway(() => Promise.reject(new TypeError("fetch failed")));
    const res = await forwardSse("http://gw/s", "tok", null, new AbortController().signal, g.fetchImpl);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("upstream_unreachable");
  });
});
