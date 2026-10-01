/** The chat wire: the bodies the panels build, the validators the proxy runs on them, the SSE
 *  reader, and the plain-words messages for every way a turn can end badly. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_MEETINGS_SESSION,
  ChatHttpError,
  type ChatEvent,
  SseDecoder,
  chatRefusalMessage,
  chatResetBody,
  chatTurnBody,
  cutStreamMessage,
  isChatResetBody,
  isChatTurnBody,
  meetingSession,
  streamChatTurn,
} from "../chat";

const meeting = { kind: "meeting" as const, meetingId: "102", platformId: "teams", nativeId: "1234567890", status: "completed" };

describe("chatTurnBody / chatResetBody", () => {
  it("builds the meeting-scoped turn in that meeting's own thread", () => {
    expect(chatTurnBody(meeting, "What did we decide?")).toEqual({
      prompt: "What did we decide?",
      session: "dashboard-meeting-102",
      context: { focus: { kind: "meeting", meeting_id: "102", platform: "teams", native_id: "1234567890", status: "completed" } },
    });
  });

  it("puts the row id in native_id for a link-less planned meeting", () => {
    const body = chatTurnBody({ ...meeting, nativeId: null, status: "scheduled" }, "prep me");
    expect(body.context).toEqual({ focus: { kind: "meeting", meeting_id: "102", platform: "teams", native_id: "102", status: "scheduled" } });
    expect(isChatTurnBody(body)).toBe(true);
  });

  it("builds the across-meetings turn with the schedule toggle and no focus", () => {
    expect(chatTurnBody({ kind: "all" }, "Which meetings mentioned Acme?", "Europe/Berlin")).toEqual({
      prompt: "Which meetings mentioned Acme?",
      session: ALL_MEETINGS_SESSION,
      context: { include: { schedule: true }, tz: "Europe/Berlin" },
    });
  });

  it("drops a time zone that is not an IANA name rather than sending it", () => {
    expect(chatTurnBody({ kind: "all" }, "q", "../../etc")).toEqual({
      prompt: "q",
      session: ALL_MEETINGS_SESSION,
      context: { include: { schedule: true } },
    });
  });

  it("every body the panels build passes the proxy's own check", () => {
    for (const status of ["active", "completed", "stopped", "scheduled", "idle", "failed"]) {
      expect(isChatTurnBody(chatTurnBody({ ...meeting, status }, "hi"))).toBe(true);
    }
    expect(isChatTurnBody(chatTurnBody({ kind: "all" }, "hi", "UTC"))).toBe(true);
    expect(isChatResetBody(chatResetBody(meeting))).toBe(true);
    expect(isChatResetBody(chatResetBody({ kind: "all" }))).toBe(true);
    expect(chatResetBody(meeting)).toEqual({ session: meetingSession("102") });
  });
});

describe("SseDecoder", () => {
  const frame = (o: unknown, id?: string) => `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(o)}\n\n`;

  it("decodes the producer's frames, ignoring ids and keepalive comments", () => {
    const d = new SseDecoder();
    const events = d.push(
      ": keepalive\n\n" +
        frame({ type: "message-delta", text: "Hel" }, "1-0") +
        frame({ type: "tool-call", tool: "Read", args: {}, callId: "c1" }, "1-1") +
        frame({ type: "tool-result", callId: "c1", ok: true, summary: "" }, "1-2") +
        frame({ type: "done", reply: "Hello", sessionId: "s", ok: true }, "1-3") +
        frame({ type: "commit", sha: "abc" }, "1-4") +
        frame({ type: "turn-complete", turn_id: null }, "1-5"),
    );
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "tool", tool: "Read" },
      { type: "other" },
      { type: "done", ok: true, reply: "Hello" },
      { type: "other" },
      { type: "turn-complete" },
    ]);
    expect(d.stray).toBe("");
  });

  it("holds a frame split across chunks until its blank line arrives, CRLF included", () => {
    const d = new SseDecoder();
    expect(d.push('data: {"type":"message-del')).toEqual([]);
    expect(d.push('ta","text":"a"}\r')).toEqual([]);
    expect(d.push("\n\r\n")).toEqual([{ type: "delta", text: "a" }]);
  });

  it("dispatches a final frame with no trailing blank line at end of stream", () => {
    const d = new SseDecoder();
    expect(d.push('data: {"type":"turn-complete"}')).toEqual([]);
    expect(d.end()).toEqual([{ type: "turn-complete" }]);
  });

  it("keeps non-SSE text (an agent-api refusal relayed inside a 200) as stray", () => {
    const d = new SseDecoder();
    expect(d.push('{"detail":"stream relay not wired"}')).toEqual([]);
    expect(d.end()).toEqual([]);
    expect(d.stray).toBe('{"detail":"stream relay not wired"}');
  });

  it("an error frame carries the producer's own words; a malformed data line is not an event", () => {
    const d = new SseDecoder();
    expect(d.push(frame({ type: "error", message: "No model credentials are configured." }) + "data: not json\n\n")).toEqual([
      { type: "error", message: "No model credentials are configured." },
      { type: "other" },
    ]);
  });

  it("a model failure arrives as done with ok false", () => {
    expect(new SseDecoder().push(frame({ type: "done", reply: "Model credentials are missing", ok: false }))).toEqual([
      { type: "done", ok: false, reply: "Model credentials are missing" },
    ]);
  });
});

function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init });
}

describe("streamChatTurn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the body to the proxy and reports every frame in order", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(['data: {"type":"message-delta","text":"A"}\n\n', 'data: {"type":"message-delta","text":"B"}\n\ndata: {"type":"turn-complete"}\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock);
    const seen: ChatEvent[] = [];
    const body = chatTurnBody(meeting, "q");
    const end = await streamChatTurn(body, (e) => seen.push(e), new AbortController().signal);
    expect(end).toEqual({ kind: "complete" });
    expect(seen).toEqual([{ type: "delta", text: "A" }, { type: "delta", text: "B" }, { type: "turn-complete" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/vexa/agent/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("an empty 200 is a cut stream, not a hang", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([])));
    expect(await streamChatTurn(chatTurnBody(meeting, "q"), () => {}, new AbortController().signal)).toEqual({ kind: "cut", stray: "" });
  });

  it("a relayed refusal is a cut stream carrying the refusal text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(['{"detail":"stream relay not wired"}'])));
    expect(await streamChatTurn(chatTurnBody(meeting, "q"), () => {}, new AbortController().signal)).toEqual({
      kind: "cut",
      stray: '{"detail":"stream relay not wired"}',
    });
  });

  it("a non-ok response throws with its status and detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 })));
    await expect(streamChatTurn(chatTurnBody(meeting, "q"), () => {}, new AbortController().signal)).rejects.toMatchObject({
      status: 400,
      detail: "invalid_body",
    });
  });

  it("aborting before the response is an aborted turn, not an error", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { ctrl.abort(); throw new DOMException("aborted", "AbortError"); }));
    expect(await streamChatTurn(chatTurnBody(meeting, "q"), () => {}, ctrl.signal)).toEqual({ kind: "aborted" });
  });

  it("a network failure throws status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(streamChatTurn(chatTurnBody(meeting, "q"), () => {}, new AbortController().signal)).rejects.toMatchObject({ status: 0 });
  });
});

describe("messages", () => {
  it("names each refusal in the reader's words", () => {
    expect(chatRefusalMessage(new ChatHttpError(0, ""))).toMatch(/Couldn't reach the dashboard server/);
    expect(chatRefusalMessage(new ChatHttpError(401, ""))).toMatch(/session expired/);
    expect(chatRefusalMessage(new ChatHttpError(403, ""))).toMatch(/isn't allowed/);
    expect(chatRefusalMessage(new ChatHttpError(404, ""))).toMatch(/isn't available on this deployment/);
    expect(chatRefusalMessage(new ChatHttpError(502, ""))).toMatch(/can't be reached/);
    expect(chatRefusalMessage(new Error("x"))).toMatch(/Something went wrong/);
  });

  it("says what a cut stream means: refusal detail, cut mid-answer, or nothing at all", () => {
    expect(cutStreamMessage('{"detail":"stream relay not wired"}', false)).toBe(
      "The assistant couldn't answer. agent-api said: stream relay not wired",
    );
    expect(cutStreamMessage("", true)).toMatch(/stopped before it finished/);
    expect(cutStreamMessage("", false)).toMatch(/No answer came back/);
    expect(cutStreamMessage("Internal Server Error", false)).toBe("The assistant couldn't answer. agent-api said: Internal Server Error");
  });
});
