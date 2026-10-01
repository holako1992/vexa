"use client";
/** A conversation with the assistant over `POST /agent/chat`, for one scope: a single meeting
 *  (`MeetingChat`, the meeting page's side panel) or all of the person's meetings (the search
 *  page's `AskAllMeetings`). Wire shapes and the stream reader live in `lib/chat.ts`.
 *
 *  What the reader sees, and when:
 *   - their question, then the answer growing as `message-delta` frames arrive;
 *   - a short "Working…" line while the agent runs a tool or has not written yet;
 *   - Stop, while an answer is streaming: it closes the stream, keeps what arrived, and marks the
 *     answer as stopped;
 *   - New conversation: agent-api forgets the thread (`/agent/chat/reset`) and the list clears;
 *   - any failure in plain words, in place of the answer: the proxy or gateway refusing
 *     (`chatRefusalMessage`), agent-api's own `error` frame (for example no model credential on
 *     this deployment), a model failure (`done` with `ok: false`), or a stream that ended
 *     without its closing frame (`cutStreamMessage`), including one that carried no bytes.
 *
 *  Answer text renders as plain React: paragraphs, with `**strong**` / `_emphasis_` through
 *  `parseInlineEmphasis`. No `dangerouslySetInnerHTML` anywhere.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Send, Square } from "lucide-react";
import {
  CHAT_PROMPT_MAX_CHARS,
  type ChatEvent,
  type ChatScope,
  chatRefusalMessage,
  chatTurnBody,
  cutStreamMessage,
  resetChat,
  streamChatTurn,
} from "@/lib/chat";
import { parseInlineEmphasis } from "@/lib/summary";
import { Button, Input, useToast } from "./ui";

interface Turn {
  id: number;
  question: string;
  answer: string;
  /** The tool the agent is running right now, cleared when it writes again. */
  working: string | null;
  state: "streaming" | "done" | "stopped" | "failed";
  /** Plain-words failure or stop note, shown under whatever answer text arrived. */
  note: string | null;
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInlineEmphasis(text).map((seg, i) =>
        seg.emphasis === "strong" ? (
          <strong key={i}>{seg.text}</strong>
        ) : seg.emphasis === "em" ? (
          <em key={i}>{seg.text}</em>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function AnswerText({ text }: { text: string }) {
  const parts = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <>
      {parts.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap break-words">
          <InlineText text={p} />
        </p>
      ))}
    </>
  );
}

export interface ChatPanelProps {
  scope: ChatScope;
  /** Placeholder and accessible name of the question field. */
  inputLabel: string;
  /** One line under the field saying what the assistant can see. */
  hint: string;
  className?: string;
}

export function ChatPanel({ scope, inputLabel, hint, className }: ChatPanelProps) {
  const { push } = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [resetting, setResetting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const streaming = turns.some((t) => t.state === "streaming");

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const patch = useCallback((id: number, fn: (t: Turn) => Turn) => {
    setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const question = draft.trim();
    if (!question || streaming) return;
    const id = nextId.current++;
    setTurns((all) => [...all, { id, question, answer: "", working: null, state: "streaming", note: null }]);
    setDraft("");

    const controller = new AbortController();
    abortRef.current = controller;
    const onEvent = (ev: ChatEvent) => {
      switch (ev.type) {
        case "delta":
          patch(id, (t) => ({ ...t, answer: t.answer + ev.text, working: null }));
          break;
        case "tool":
          patch(id, (t) => ({ ...t, working: ev.tool }));
          break;
        case "done":
          patch(id, (t) =>
            ev.ok
              ? { ...t, answer: t.answer || ev.reply, working: null }
              : { ...t, working: null, state: "failed", note: ev.reply ? `The model couldn't answer: ${ev.reply}` : "The model couldn't answer." },
          );
          break;
        case "error":
          patch(id, (t) => ({ ...t, working: null, state: "failed", note: ev.message }));
          break;
        default:
          break;
      }
    };

    try {
      const end = await streamChatTurn(chatTurnBody(scope, question, browserTimeZone()), onEvent, controller.signal);
      patch(id, (t) => {
        if (t.state !== "streaming") return t;
        if (end.kind === "complete") return { ...t, state: "done", working: null };
        if (end.kind === "aborted") return { ...t, state: "stopped", working: null, note: "Stopped. The answer above is incomplete." };
        return { ...t, state: "failed", working: null, note: cutStreamMessage(end.stray, !!t.answer) };
      });
    } catch (err) {
      console.warn("chat turn failed", err);
      patch(id, (t) => ({ ...t, state: "failed", working: null, note: chatRefusalMessage(err) }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function newConversation() {
    abortRef.current?.abort();
    setResetting(true);
    try {
      await resetChat(scope);
      setTurns([]);
      push({ tone: "success", title: "Started a new conversation." });
      inputRef.current?.focus();
    } catch (err) {
      console.warn("chat reset failed", err);
      push({ tone: "error", title: "Couldn't start a new conversation.", description: chatRefusalMessage(err) });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className={"flex min-h-0 flex-col " + (className ?? "")}>
      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        aria-busy={streaming || undefined}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto"
      >
        {turns.length === 0 && <p className="text-sm text-ink-3">Ask a question to start.</p>}
        {turns.map((t) => (
          <div key={t.id} className="space-y-2" data-chat-turn={t.state}>
            <p className="ml-8 rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink" data-chat-role="user">
              {t.question}
            </p>
            <div className="space-y-2 text-sm leading-relaxed text-ink-2" data-chat-role="assistant">
              {t.answer && <AnswerText text={t.answer} />}
              {t.state === "streaming" && (
                <p className="text-xs text-ink-3" role="status">
                  {t.working ? `Working: ${t.working}…` : t.answer ? "Writing…" : "Working…"}
                </p>
              )}
              {t.note && (
                <p role={t.state === "failed" ? "alert" : "status"} className={t.state === "failed" ? "text-live" : "text-ink-3"}>
                  {t.note}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={ask} className="mt-4 space-y-2 border-t border-line pt-4">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={inputLabel}
          aria-label={inputLabel}
          hint={hint}
          maxLength={CHAT_PROMPT_MAX_CHARS}
          autoComplete="off"
        />
        <div className="flex flex-wrap items-center gap-2">
          {streaming ? (
            <Button variant="secondary" onClick={stop} icon={<Square size={14} aria-hidden />}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!draft.trim()} icon={<Send size={14} aria-hidden />}>
              Ask
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => void newConversation()}
            loading={resetting}
            icon={<MessageSquarePlus size={14} aria-hidden />}
          >
            New conversation
          </Button>
        </div>
      </form>
    </div>
  );
}
