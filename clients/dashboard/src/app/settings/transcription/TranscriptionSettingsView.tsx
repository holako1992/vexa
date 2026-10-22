"use client";
/** `/settings/transcription`: the name the bot joins as, and which service transcribes the
 *  account's meetings.
 *
 *  Two producer stores, each read and written where the core keeps it — never a copy here:
 *
 *   - **Bot name** is the account's default bot name, `GET/PUT /user/calendar {bot_name}`. Every bot
 *     sent without a name of its own (the Send Bot form, calendar auto-join) joins under it, and it
 *     is the same field the first-run welcome writes.
 *   - **Transcription service** is `GET/PUT /user/transcription {url, token}`: the deployment's own
 *     service, or the person's own endpoint. The token is write-only: the page says whether one is
 *     saved and never shows or prefills it.
 *
 *  Language is stated, not set: the core takes it per bot, and detects it otherwise.
 *
 *  Loading, "could not ask" (with a retry) and loaded are three different screens, so a failed
 *  read never shows up as a default value. Every save confirms or fails through a toast.
 */
import { useEffect, useState } from "react";
import { ApiError, getJson, mutateJson, presentError } from "@/lib/api";
import { BOT_NAME_MAX, checkBotName } from "@/lib/firstRun";
import {
  SETTING_MAX,
  type TranscriptionBackend,
  parseDefaultBotName,
  parseTranscriptionBackend,
  planBackendSave,
} from "@/lib/transcriptionSettings";
import { Button, Input, useToast } from "@/components/ui";
import { ErrorState, LoadingState } from "@/components/EmptyState";

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; botName: string; backend: TranscriptionBackend };

/** A refusal the producer explained (422 with a string `detail`) is shown in its words; anything
 *  else in the shared vocabulary. */
function describeFailure(e: unknown): string {
  if (e instanceof ApiError && e.status === 422 && e.detail) return e.detail;
  return presentError(e);
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-ink-3">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function BotNameSection({ saved, onSaved }: { saved: string; onSaved: (name: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(saved);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const checked = checkBotName(name);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    try {
      const answer = await mutateJson<unknown>("PUT", "/api/vexa/user/calendar", { bot_name: checked.name });
      const stored = parseDefaultBotName(answer) ?? checked.name;
      setName(stored);
      setError(undefined);
      onSaved(stored);
      toast.push({ tone: "success", title: `Your bot will join as “${stored}”.` });
    } catch (err) {
      const msg = describeFailure(err);
      setError(msg);
      toast.push({ tone: "error", title: "Couldn't save the bot's name", description: msg });
    } finally {
      setSaving(false);
    }
  }

  const unchanged = name.trim() === saved;
  return (
    <Section
      title="Bot name"
      hint="What people in the meeting see. Every bot you send without a name of its own, and every bot your calendar sends, joins under it."
    >
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Input
          label="Name"
          name="bot_name"
          value={name}
          maxLength={BOT_NAME_MAX}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          error={error}
          containerClassName="flex-1"
          data-testid="bot-name-input"
        />
        <Button type="submit" variant="primary" loading={saving} disabled={unchanged} className="sm:mt-[26px]">
          Save name
        </Button>
      </form>
    </Section>
  );
}

function BackendSection({ saved, onSaved }: { saved: TranscriptionBackend; onSaved: (b: TranscriptionBackend) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState(saved.url ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState<"save" | "reset" | null>(null);

  async function put(body: { url?: string; token?: string }, kind: "save" | "reset") {
    setSaving(kind);
    try {
      const answer = await mutateJson<unknown>("PUT", "/api/vexa/user/transcription", body);
      const stored = parseTranscriptionBackend(answer) ?? {
        url: body.url === undefined ? saved.url : body.url || null,
        tokenSet: body.token === undefined ? saved.tokenSet : body.token !== "",
      };
      setUrl(stored.url ?? "");
      setToken("");
      setError(undefined);
      onSaved(stored);
      toast.push({
        tone: "success",
        title: stored.url ? "Your meetings will be transcribed by your endpoint." : "Your meetings will be transcribed by this Vexa's service.",
        description: "This applies to bots sent from now on.",
      });
    } catch (err) {
      const msg = describeFailure(err);
      setError(msg);
      toast.push({ tone: "error", title: "Couldn't save the transcription service", description: msg });
    } finally {
      setSaving(null);
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const plan = planBackendSave(saved, { url, token });
    if (!plan.ok) {
      setError(plan.message);
      return;
    }
    void put(plan.body, "save");
  }

  const tokenHint = saved.url && saved.tokenSet
    ? "A token is saved. Leave this empty to keep it, or enter a new one. Changing the URL without a new token removes it."
    : "Optional. Sent only to the endpoint above.";

  return (
    <Section
      title="Transcription service"
      hint="Which service turns your meetings' audio into text. Changes apply to bots sent after you save."
    >
      <p className="mb-4 text-sm text-ink-2" data-testid="backend-current">
        {saved.url ? (
          <>
            Using your endpoint: <span className="break-all font-medium text-ink">{saved.url}</span>
            {saved.tokenSet ? " (token saved)" : " (no token)"}
          </>
        ) : (
          "Using this Vexa's transcription service."
        )}
      </p>
      <form onSubmit={save} className="flex flex-col gap-3">
        <Input
          label="Your endpoint URL"
          name="transcription_url"
          type="url"
          inputMode="url"
          placeholder="https://stt.example.com/v1"
          value={url}
          maxLength={SETTING_MAX}
          autoComplete="off"
          hint="An OpenAI-compatible transcription endpoint. Leave empty to use this Vexa's service."
          onChange={(e) => {
            setUrl(e.target.value);
            setError(undefined);
          }}
          error={error}
          data-testid="backend-url-input"
        />
        <Input
          label="Token"
          name="transcription_token"
          type="password"
          value={token}
          maxLength={SETTING_MAX}
          autoComplete="new-password"
          hint={tokenHint}
          onChange={(e) => {
            setToken(e.target.value);
            setError(undefined);
          }}
          data-testid="backend-token-input"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={saving === "save"} disabled={saving !== null}>
            Save service
          </Button>
          {(saved.url || saved.tokenSet) && (
            <Button
              variant="secondary"
              loading={saving === "reset"}
              disabled={saving !== null}
              onClick={() => void put({ url: "", token: "" }, "reset")}
            >
              Use this Vexa&apos;s service
            </Button>
          )}
        </div>
      </form>
    </Section>
  );
}

export function TranscriptionSettingsView() {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getJson<unknown>("/api/vexa/user/calendar"), getJson<unknown>("/api/vexa/user/transcription")])
      .then(([calendar, transcription]) => {
        if (cancelled) return;
        const botName = parseDefaultBotName(calendar);
        const backend = parseTranscriptionBackend(transcription);
        if (botName === null || backend === null) {
          setState({ kind: "error", message: "Couldn't read your transcription settings — the answer was not in the expected shape." });
          return;
        }
        setState({ kind: "loaded", botName, backend });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: `Couldn't load your transcription settings. ${presentError(e)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (state.kind === "loading") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-6 text-xl font-semibold">Transcription</h1>
        <LoadingState label="Loading your transcription settings…" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-6 text-xl font-semibold">Transcription</h1>
        <ErrorState
          message={state.message}
          onRetry={() => {
            setState({ kind: "loading" });
            setReloadKey((k) => k + 1);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 p-6">
      <h1 className="text-xl font-semibold">Transcription</h1>

      <BotNameSection
        saved={state.botName}
        onSaved={(botName) => setState((s) => (s.kind === "loaded" ? { ...s, botName } : s))}
      />

      <Section title="Language">
        <p className="text-sm text-ink-2" data-testid="language-note">
          Detected on its own for each few seconds of speech. To pin one language for a bot, send it
          through the API with{" "}
          <code className="rounded bg-raised px-1 py-0.5 text-[13px]">language</code> set.
        </p>
      </Section>

      <BackendSection
        saved={state.backend}
        onSaved={(backend) => setState((s) => (s.kind === "loaded" ? { ...s, backend } : s))}
      />
    </div>
  );
}
