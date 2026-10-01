"use client";
/** "Ask across all my meetings" on the search page: a `ChatPanel` with no meeting focus.
 *
 *  The turn carries the schedule digest toggle (`include.schedule`) and no focus, so agent-api
 *  answers from the person's own workspace (each completed meeting's summary note lives there at
 *  `meetings/<id>/summary.md`) plus a digest of their recent and upcoming meetings. It does not
 *  fold full transcripts; the keyword search above this panel is the way to find exact words.
 *
 *  Collapsed until asked for, so the search page still opens on its search field.
 */
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { ChatPanel } from "./ChatPanel";
import { Button } from "./ui";

export function AskAllMeetings() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Ask across all my meetings" className="mb-6 rounded-card border border-line bg-card p-4">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="ask-all-meetings-panel"
        icon={<MessageSquare size={15} aria-hidden />}
      >
        Ask across all my meetings
      </Button>
      {open && (
        <div id="ask-all-meetings-panel" className="mt-3">
          <ChatPanel
            scope={{ kind: "all" }}
            className="max-h-[32rem]"
            inputLabel="Ask across all my meetings"
            hint="Answers come from your meeting summaries and your schedule. Use search above to find exact words."
          />
        </div>
      )}
    </section>
  );
}
