/** The assistant chat: the exact wire shapes the dashboard sends to `POST /agent/chat` and
 *  `POST /agent/chat/reset`, the checks the proxy allowlist runs on them, and the reader that
 *  turns the streamed answer into events.
 *
 *  The producer is agent-api (`core/agent/control_plane/api.py`, `ChatBody`/`ResetBody`, fronted
 *  by the gateway's streamed `/agent/chat`). What it does with a body:
 *   - `subject` is derived from the caller's API key; the body never names a user.
 *   - `session` names one conversation thread inside that subject; the dashboard uses one thread
 *     per meeting (`dashboard-meeting-<row id>`) and one for the search page
 *     (`dashboard-all-meetings`), so no dashboard turn ever lands in a thread the person opened
 *     elsewhere (`main` and friends are never addressed from here).
 *   - `context.focus = {kind: "meeting", meeting_id, …}` folds that meeting's processed notes
 *     (or raw transcript) into the prompt, by lifecycle phase (`status`).
 *   - `context.include.schedule = true` folds the person's schedule digest; the search page's
 *     "across all my meetings" turn sends that and no focus.
 *
 *  The answer is Server-Sent Events, one JSON frame per `data:` line (`docs/docs/api/agent.mdx`):
 *  `message-delta {text}`, `tool-call {tool}`, `tool-result`, `commit`, `rejected`,
 *  `done {reply, ok}`, `error {message}`, and `turn-complete`, the frame that ends the turn.
 *  The gateway answers every stream with `200 text/event-stream` and copies agent-api's bytes
 *  verbatim, so an agent-api refusal (`501 {"detail": …}`, a `422`) arrives as a bare JSON line
 *  inside a 200, and an unreachable agent-api arrives as an empty 200. `SseDecoder` keeps such
 *  non-SSE text as `stray` so the panel can say what happened instead of waiting forever.
 *
 *  Dependency-free: `upstream.ts` imports the two validators below.
 */

/** Longest prompt the dashboard sends. agent-api sets no bound of its own; this one keeps a
 *  pasted document from becoming a multi-megabyte prompt through the proxy. */
export const CHAT_PROMPT_MAX_CHARS = 4000;

/** The search page's one conversation thread. */
export const ALL_MEETINGS_SESSION = "dashboard-all-meetings";

const MEETING_SESSION_PREFIX = "dashboard-meeting-";

/** The meeting page's conversation thread for one meeting row. */
export function meetingSession(meetingId: string): string {
  return `${MEETING_SESSION_PREFIX}${meetingId}`;
}

const ROW_ID = /^\d{1,20}$/;
const NATIVE_ID = /^[^/?#\s\u0000-\u001f]{1,256}$/;
const CHAT_PLATFORMS = new Set(["google_meet", "teams", "zoom", "jitsi"]);
/** Raw meeting statuses meeting-api writes, plus the dashboard's `stopped` (a completed meeting
 *  whose bot was stopped). agent-api maps them to the prep/live/post grounding phase. */
const MEETING_STATUSES = new Set([
  "idle", "scheduled",
  "requested", "joining", "awaiting_admission", "active", "needs_help", "stopping",
  "completed", "failed", "stopped",
]);
/** An IANA zone name (`Europe/Berlin`, `America/Argentina/Buenos_Aires`, `UTC`). */
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(\/[A-Za-z0-9_+-]{1,30}){0,2}$/;

export type ChatScope =
  | { kind: "meeting"; meetingId: string; platformId: string; nativeId: string | null; status: string }
  | { kind: "all" };

export interface MeetingFocus {
  kind: "meeting";
  meeting_id: string;
  platform: string;
  native_id: string;
  status: string;
}

export interface ChatTurnBody {
  prompt: string;
  session: string;
  context: { focus: MeetingFocus } | { include: { schedule: true }; tz?: string };
}

export interface ChatResetBody {
  session: string;
}

export function sessionFor(scope: ChatScope): string {
  return scope.kind === "meeting" ? meetingSession(scope.meetingId) : ALL_MEETINGS_SESSION;
}

/** The body for one turn. A link-less planned meeting has no native id; its row id rides in
 *  `native_id`, which agent-api retries as a row id when it looks the meeting up. */
export function chatTurnBody(scope: ChatScope, prompt: string, tz?: string): ChatTurnBody {
  if (scope.kind === "meeting") {
    return {
      prompt,
      session: meetingSession(scope.meetingId),
      context: {
        focus: {
          kind: "meeting",
          meeting_id: scope.meetingId,
          platform: scope.platformId,
          native_id: scope.nativeId || scope.meetingId,
          status: scope.status,
        },
      },
    };
  }
  const context: { include: { schedule: true }; tz?: string } = { include: { schedule: true } };
  if (tz && TIME_ZONE.test(tz)) context.tz = tz;
  return { prompt, session: ALL_MEETINGS_SESSION, context };
}

export function chatResetBody(scope: ChatScope): ChatResetBody {
  return { session: sessionFor(scope) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  if (!required.every((k) => Object.hasOwn(o, k))) return false;
  return keys.every((k) => required.includes(k) || optional.includes(k));
}

/** A prompt the dashboard would send: a string with something in it, within the length bound,
 *  and free of NUL. */
export function isPromptText(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= CHAT_PROMPT_MAX_CHARS && !v.includes("\u0000");
}

function isMeetingFocus(v: unknown): v is MeetingFocus {
  if (!isPlainObject(v)) return false;
  if (!hasExactKeys(v, ["kind", "meeting_id", "platform", "native_id", "status"])) return false;
  return (
    v.kind === "meeting" &&
    typeof v.meeting_id === "string" && ROW_ID.test(v.meeting_id) &&
    typeof v.platform === "string" && CHAT_PLATFORMS.has(v.platform) &&
    typeof v.native_id === "string" && NATIVE_ID.test(v.native_id) &&
    typeof v.status === "string" && MEETING_STATUSES.has(v.status)
  );
}

/** `POST /agent/chat`'s body through the proxy, exactly one of the two shapes `chatTurnBody`
 *  builds. Refused: any other top-level key (`active`, `subject`, `turn_id`…), a session that is
 *  not the dashboard's own thread for the focused meeting, a focus naming anything but one
 *  numeric meeting row, a workspace/file/today focus, and the across-meetings shape carrying a
 *  focus at all. */
export function isChatTurnBody(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  if (!hasExactKeys(parsed, ["prompt", "session", "context"])) return false;
  if (!isPromptText(parsed.prompt)) return false;
  const { session, context } = parsed;
  if (typeof session !== "string" || !isPlainObject(context)) return false;

  if (Object.hasOwn(context, "focus")) {
    if (!hasExactKeys(context, ["focus"])) return false;
    const focus = context.focus;
    return isMeetingFocus(focus) && session === meetingSession(focus.meeting_id);
  }
  if (!hasExactKeys(context, ["include"], ["tz"])) return false;
  const include = context.include;
  if (!isPlainObject(include) || !hasExactKeys(include, ["schedule"]) || include.schedule !== true) return false;
  if (Object.hasOwn(context, "tz") && !(typeof context.tz === "string" && TIME_ZONE.test(context.tz))) return false;
  return session === ALL_MEETINGS_SESSION;
}

/** `POST /agent/chat/reset`'s body through the proxy: exactly `{session}`, and only one of the
 *  dashboard's own threads. */
export function isChatResetBody(parsed: unknown): boolean {
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, ["session"])) return false;
  const session = parsed.session;
  if (typeof session !== "string") return false;
  if (session === ALL_MEETINGS_SESSION) return true;
  return session.startsWith(MEETING_SESSION_PREFIX) && ROW_ID.test(session.slice(MEETING_SESSION_PREFIX.length));
}

// ── reading the stream ────────────────────────────────────────────────────────────────────────

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; tool: string }
  | { type: "done"; ok: boolean; reply: string }
  | { type: "error"; message: string }
  | { type: "turn-complete" }
  | { type: "other" };

function toChatEvent(frame: unknown): ChatEvent {
  if (!isPlainObject(frame)) return { type: "other" };
  switch (frame.type) {
    case "message-delta":
      return typeof frame.text === "string" ? { type: "delta", text: frame.text } : { type: "other" };
    case "tool-call":
      return { type: "tool", tool: typeof frame.tool === "string" ? frame.tool : "a tool" };
    case "done":
      return { type: "done", ok: frame.ok !== false, reply: typeof frame.reply === "string" ? frame.reply : "" };
    case "error":
      return { type: "error", message: typeof frame.message === "string" && frame.message ? frame.message : "The assistant reported an error." };
    case "turn-complete":
      return { type: "turn-complete" };
    default:
      return { type: "other" };
  }
}

/** Incremental SSE decoder: feed it text chunks as they arrive, get back whole events. A frame
 *  split across chunks is held until its blank line arrives. Comment lines (`: keepalive`) and
 *  `id:`/`event:`/`retry:` fields are consumed silently; any line that is not SSE at all is kept
 *  in `stray` (that is how an agent-api refusal relayed inside a 200 shows up). */
export class SseDecoder {
  private buffer = "";
  private data: string[] = [];
  stray = "";

  push(chunk: string): ChatEvent[] {
    this.buffer += chunk;
    const out: ChatEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith("\r\n", nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      this.line(line, out);
    }
    return out;
  }

  /** The stream ended: dispatch a final frame that had no trailing blank line. */
  end(): ChatEvent[] {
    const out: ChatEvent[] = [];
    if (this.buffer) {
      this.line(this.buffer, out);
      this.buffer = "";
    }
    this.line("", out);
    return out;
  }

  private line(line: string, out: ChatEvent[]): void {
    if (line === "") {
      if (this.data.length) {
        const payload = this.data.join("\n");
        this.data = [];
        try {
          out.push(toChatEvent(JSON.parse(payload)));
        } catch {
          out.push({ type: "other" });
        }
      }
      return;
    }
    if (line.startsWith(":")) return;
    const m = /^(data|id|event|retry)(?::\s?(.*))?$/.exec(line);
    if (!m) {
      this.stray += (this.stray ? "\n" : "") + line;
      return;
    }
    if (m[1] === "data") this.data.push(m[2] ?? "");
  }
}

/** How a turn's stream ended, as far as the reader can tell. */
export type TurnEnd =
  | { kind: "complete" }
  | { kind: "aborted" }
  | { kind: "cut"; stray: string };

export class ChatHttpError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(`chat request failed: ${status || "network"}${detail ? `: ${detail}` : ""}`);
    this.name = "ChatHttpError";
  }
}

async function errorDetail(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { detail?: unknown; error?: unknown };
    const d = b?.detail ?? b?.error;
    return typeof d === "string" ? d : d != null ? JSON.stringify(d).slice(0, 200) : "";
  } catch {
    return "";
  }
}

/** Send one turn through the dashboard proxy and call `onEvent` for every frame as it arrives.
 *  Resolves with how the stream ended; throws `ChatHttpError` when the proxy or gateway refused
 *  the request outright (status 0 for a network failure). Aborting `signal` closes the stream,
 *  and the proxy closes its upstream connection in turn. */
export async function streamChatTurn(
  body: ChatTurnBody,
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<TurnEnd> {
  let r: Response;
  try {
    r = await fetch("/api/vexa/agent/chat", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) return { kind: "aborted" };
    throw new ChatHttpError(0, e instanceof Error ? e.message : "network error");
  }
  if (!r.ok) throw new ChatHttpError(r.status, await errorDetail(r));
  if (!r.body) return { kind: "cut", stray: "" };

  const decoder = new SseDecoder();
  const text = new TextDecoder();
  const reader = r.body.getReader();
  let sawEnd = false;
  const emit = (events: ChatEvent[]) => {
    for (const e of events) {
      if (e.type === "turn-complete") sawEnd = true;
      onEvent(e);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      emit(decoder.push(text.decode(value, { stream: true })));
      if (sawEnd) {
        void reader.cancel().catch(() => {});
        return { kind: "complete" };
      }
    }
    emit(decoder.push(text.decode()));
    emit(decoder.end());
  } catch {
    if (signal.aborted) return { kind: "aborted" };
    return { kind: "cut", stray: decoder.stray };
  }
  if (sawEnd) return { kind: "complete" };
  if (signal.aborted) return { kind: "aborted" };
  return { kind: "cut", stray: decoder.stray };
}

/** Start the scope's conversation over: agent-api drops the thread and its continuity, so the
 *  next turn begins with no memory of earlier ones. */
export async function resetChat(scope: ChatScope): Promise<void> {
  let r: Response;
  try {
    r = await fetch("/api/vexa/agent/chat/reset", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatResetBody(scope)),
    });
  } catch (e) {
    throw new ChatHttpError(0, e instanceof Error ? e.message : "network error");
  }
  if (!r.ok) throw new ChatHttpError(r.status, await errorDetail(r));
}

// ── words for the reader ──────────────────────────────────────────────────────────────────────

/** The sentence shown when the proxy or gateway refused a turn before any answer started. */
export function chatRefusalMessage(e: unknown): string {
  if (!(e instanceof ChatHttpError)) return "Something went wrong sending your question. Details are in the browser console.";
  switch (e.status) {
    case 0: return "Couldn't reach the dashboard server. Check your connection and try again.";
    case 400: return "The dashboard refused to send that message.";
    case 401: return "Your session expired. Sign in again.";
    case 403: return "Your account isn't allowed to use the assistant.";
    case 404: return "The assistant isn't available on this deployment.";
    case 429: return "Too many requests. Try again in a moment.";
    case 502:
    case 503:
    case 504: return "The assistant can't be reached right now.";
    default: return `The assistant request failed (${e.status}).`;
  }
}

/** The sentence shown when a stream ended without its `turn-complete` frame. `stray` is any
 *  non-SSE text the stream carried (an agent-api refusal relayed inside the 200); `hadAnswer`
 *  says whether some answer text already arrived. */
export function cutStreamMessage(stray: string, hadAnswer: boolean): string {
  const detail = strayDetail(stray);
  if (detail) return `The assistant couldn't answer. agent-api said: ${detail}`;
  if (hadAnswer) return "The answer stopped before it finished. Ask again to retry.";
  return "No answer came back. The assistant may not be set up on this deployment.";
}

function strayDetail(stray: string): string {
  const text = stray.trim();
  if (!text) return "";
  try {
    const b = JSON.parse(text) as { detail?: unknown };
    if (typeof b?.detail === "string" && b.detail) return b.detail;
    if (b?.detail != null) return JSON.stringify(b.detail).slice(0, 300);
  } catch {
    // not JSON: show the text itself, bounded
  }
  return text.slice(0, 300);
}
