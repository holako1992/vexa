"use client";
/** "Ask about this meeting": a button on the meeting page that opens a side panel holding a
 *  `ChatPanel` scoped to this one meeting row.
 *
 *  Owner only. A meeting shared with the reader renders nothing here: agent-api grounds a turn in
 *  the caller's own workspace and meeting rows, and the dashboard does not offer a viewer a chat
 *  about a meeting that is not theirs.
 *
 *  The panel is not modal: the transcript stays readable and scrollable beside it. Escape or the
 *  close button hides it and returns focus to the button that opened it. Hiding keeps the
 *  conversation (and any answer still streaming) mounted, so reopening shows it as it was.
 */
import { useEffect, useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import type { Meeting } from "@/lib/meetings";
import type { ChatScope } from "@/lib/chat";
import { ChatPanel } from "./ChatPanel";
import { Button } from "./ui";

export function MeetingChat({ meeting }: { meeting: Meeting }) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        openerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (meeting.shared) return null;

  const scope: ChatScope = {
    kind: "meeting",
    meetingId: meeting.id,
    platformId: meeting.platformId,
    nativeId: meeting.nativeId,
    status: meeting.status,
  };

  function close() {
    setOpen(false);
    openerRef.current?.focus();
  }

  return (
    <div className="mb-6 print:hidden">
      <Button
        ref={openerRef}
        variant="secondary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="meeting-chat-panel"
        icon={<MessageSquare size={15} aria-hidden />}
      >
        Ask about this meeting
      </Button>
      <aside
        id="meeting-chat-panel"
        ref={panelRef}
        aria-label="Chat about this meeting"
        hidden={!open}
        className={(open ? "flex" : "hidden") + " fixed inset-y-0 right-0 z-40 w-full max-w-md flex-col border-l border-line bg-card p-5 shadow-2xl"}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold">Ask about this meeting</h2>
          <Button variant="ghost" size="sm" onClick={close} aria-label="Close chat" icon={<X size={15} aria-hidden />} />
        </div>
        <ChatPanel
          scope={scope}
          className="flex-1"
          inputLabel="Ask about this meeting"
          hint="Answers come from this meeting's notes and transcript. The assistant remembers this conversation until you start a new one."
        />
      </aside>
    </div>
  );
}
