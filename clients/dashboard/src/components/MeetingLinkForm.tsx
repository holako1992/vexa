"use client";
/**
 * Paste a Google Meet / Zoom / Teams / Jitsi link and send a Vexa bot to it.
 *
 * The one place a pasted link becomes `POST /bots`: the Add Bot dialog's "Meeting link" tab and the
 * first-run welcome's last step both render it, so parsing, the live platform feedback, the
 * allowance line and the plain-words refusal for a spent or unverified allowance behave the same in
 * both.
 *
 * The remaining-allowance line is informational only. The server is the authority on whether a send
 * is admitted, so a stale or failed read here never disables the button; a refusal comes back as a
 * `402 {"error": "quota_exceeded"}` and is shown as a sentence with a way forward.
 */
import { useCallback, useEffect, useState } from "react";
import { Bot, Check } from "lucide-react";
import clsx from "clsx";
import { getJson, mutateJson, presentError, ApiError } from "@/lib/api";
import { parseMeetingInput, type ParsedMeeting } from "@/lib/meetingId";
import {
  formatRemainingAllowance,
  isQuotaExceeded,
  type Entitlements,
  type QuotaExceededBody,
} from "@/lib/entitlements";
import { isAllowanceSpent, quotaNoticeFrom, type QuotaNotice } from "@/lib/quotaNotice";
import { Button, Input, useToast } from "./ui";

const PLATFORM_LABELS: Record<string, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  jitsi: "Jitsi",
};

const PLATFORM_COLORS: Record<string, string> = {
  google_meet: "bg-ok-soft text-ok",
  zoom: "bg-accent-soft text-accent",
  teams: "bg-accent-soft text-accent",
  jitsi: "bg-warn-soft text-warn",
};

interface BotSendPayload {
  platform: string;
  native_meeting_id: string;
  meeting_url?: string;
}

/** What `POST /bots` answers that a caller needs: the new meeting's row id, when it sent one. */
export interface DispatchedBot {
  id: number | null;
}

export interface MeetingLinkFormProps {
  /** Called after a bot is sent. */
  onSent: (bot: DispatchedBot) => void;
  /** Where the remaining-allowance line sits. `above` puts it before the field, for a surface
   *  where a person should know what they have before they paste anything. */
  allowance?: "above" | "below";
  /** Shown whenever the allowance is spent or a send was refused for it — somewhere else to go
   *  from a dead end (the welcome offers connecting a calendar). */
  whenBlocked?: React.ReactNode;
  autoFocus?: boolean;
}

type Result = { ok: true; msg: string } | QuotaNotice | { ok: false; msg: string; link?: undefined };

export function MeetingLinkForm({ onSent, allowance = "below", whenBlocked, autoFocus = true }: MeetingLinkFormProps) {
  const [url, setUrl] = useState("");
  const [parsed, setParsed] = useState<ParsedMeeting | null>(null);
  const [jitsiHosts, setJitsiHosts] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [refusedForQuota, setRefusedForQuota] = useState(false);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [botName, setBotName] = useState("Vexa");
  const toast = useToast();

  useEffect(() => {
    getJson<{ hosts?: string[] }>("/api/vexa/meeting/jitsi-hosts")
      .then((d) => setJitsiHosts(Array.isArray(d.hosts) ? d.hosts : []))
      .catch(() => {});
    getJson<Entitlements>("/api/vexa/user/entitlements")
      .then(setEntitlements)
      .catch(() => {});
    // The name people in the meeting will see: the person's default, which a dispatch without a
    // name of its own uses. Falls back to the product name if it can't be read.
    getJson<{ bot_name?: unknown }>("/api/vexa/user/calendar")
      .then((d) => { if (typeof d.bot_name === "string" && d.bot_name) setBotName(d.bot_name); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setParsed(parseMeetingInput(url, jitsiHosts));
  }, [url, jitsiHosts]);

  const send = useCallback(async () => {
    if (!parsed) return;
    setSending(true);
    setResult(null);
    const payload: BotSendPayload = {
      platform: parsed.platform,
      native_meeting_id: parsed.native_meeting_id,
      meeting_url: url.trim() || undefined,
    };
    try {
      const bot = await mutateJson<{ id?: unknown }>("POST", "/api/vexa/bots", payload);
      setResult({ ok: true, msg: "Bot is joining the meeting." });
      toast.push({ tone: "success", title: "Bot is joining the meeting." });
      setUrl("");
      setRefusedForQuota(false);
      onSent({ id: typeof bot?.id === "number" ? bot.id : null });
    } catch (e) {
      // Branch on the RESPONSE BODY's `error` field, never on the 402 status alone — a
      // 402 with a different body is a different failure, and presentError's generic 402 text
      // would lose the reset date and upgrade link this shape carries.
      if (e instanceof ApiError && isQuotaExceeded(e.body)) {
        const notice = quotaNoticeFrom(e.body as QuotaExceededBody);
        setResult(notice);
        setRefusedForQuota(true);
        toast.push({ tone: "error", title: "Meeting quota reached", description: notice.msg });
      } else {
        const msg = presentError(e);
        setResult({ ok: false, msg });
        toast.push({ tone: "error", title: "Couldn't send the bot", description: msg });
      }
    } finally {
      setSending(false);
    }
  }, [parsed, url, onSent, toast]);

  const remaining = entitlements ? formatRemainingAllowance(entitlements) : null;
  const blocked = refusedForQuota || (entitlements ? isAllowanceSpent(entitlements) : false);
  const allowanceLine = remaining && (
    <p
      className={clsx("text-xs", allowance === "above" ? "text-ink-2" : "text-center text-ink-3")}
      data-testid="allowance-line"
    >
      {remaining}
    </p>
  );

  return (
    <div className="flex flex-col gap-5">
      {allowance === "above" && allowanceLine}

      <Input
        id="meeting-url-input"
        label="Meeting URL"
        type="url"
        value={url}
        onChange={(e) => { setUrl(e.target.value); setResult(null); }}
        onKeyDown={(e) => { if (e.key === "Enter" && parsed && !sending) void send(); }}
        placeholder="https://meet.google.com/abc-defg-hij"
        autoFocus={autoFocus}
      />

      {/* Live parse feedback */}
      <div className="-mt-3 h-5 text-xs">
        {parsed ? (
          <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium", PLATFORM_COLORS[parsed.platform] ?? "bg-raised text-ink-2")}>
            <Check size={11} aria-hidden />
            {PLATFORM_LABELS[parsed.platform] ?? parsed.platform}
            <span className="opacity-70">· {parsed.native_meeting_id}</span>
          </span>
        ) : url ? (
          <span className="text-ink-3">Paste a Google Meet, Zoom, Teams, or Jitsi link.</span>
        ) : null}
      </div>

      {result && (
        <div
          role="status"
          className={clsx(
            "rounded-lg border px-4 py-2.5 text-sm",
            result.ok
              ? "border-ok/30 bg-ok-soft text-ok"
              : "border-live/30 bg-live-soft text-live",
          )}
        >
          {result.msg}
          {!result.ok && result.link && (
            <>
              {" "}
              <a href={result.link.href} className="font-medium underline underline-offset-2">
                {result.link.label}
              </a>
            </>
          )}
        </div>
      )}

      <Button
        variant="primary"
        onClick={send}
        disabled={!parsed}
        loading={sending}
        icon={<Bot size={15} aria-hidden />}
        className="h-10"
      >
        {sending ? "Sending…" : "Send Bot"}
      </Button>

      {blocked && whenBlocked}

      {allowance === "below" && allowanceLine}

      <p className="text-center text-xs text-ink-3">
        The bot will join the meeting and begin transcribing. It appears in the meeting as &quot;{botName}&quot;.
      </p>
    </div>
  );
}
