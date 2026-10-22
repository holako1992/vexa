/** The transcription settings page's shapes and pure rules.
 *
 *  Dependency-free like `upstream.ts` and `firstRun.ts`, so the rules are tested directly. Every
 *  value here is the producer's: admin-api keeps both stores in `users.data`.
 *
 *   - The default bot name is `users.data.calendar_bot_name`, read and written through
 *     `GET/PUT /user/calendar {bot_name}` — the one store meetings resolves when a bot is sent
 *     without a name of its own, and the one the first-run welcome writes. Its rules
 *     (`checkBotName`, `isBotNameBody`) live in `firstRun.ts` and are reused, not restated.
 *   - The transcription backend override is `users.data.transcription_prefs`, read and written
 *     through `GET/PUT /user/transcription {url, token}`. The token is a secret: the read says
 *     only whether one is set (`token_set`), and this client never shows, stores or sends back
 *     what the read carries for it.
 *
 *  Language is not an account setting: the core takes it per bot (`language` on `POST /bots`), and
 *  a bot sent without one detects the language of each stretch of speech.
 */

/** admin-api's `_validate_config_fields` ceiling for every settings string. */
export const SETTING_MAX = 2048;

/** `GET /user/transcription`, as this client uses it. `url` is `null` when the account uses the
 *  deployment's own transcription service. */
export interface TranscriptionBackend {
  url: string | null;
  tokenSet: boolean;
}

/** `GET /user/transcription`'s body, or `null` when it is not that shape — a page that cannot
 *  read the answer says so, it never guesses "not configured". The masked `token` field the
 *  producer also returns is deliberately not read. */
export function parseTranscriptionBackend(raw: unknown): TranscriptionBackend | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { url, token_set: tokenSet } = raw as Record<string, unknown>;
  if (url !== null && url !== undefined && typeof url !== "string") return null;
  if (typeof tokenSet !== "boolean") return null;
  return { url: typeof url === "string" && url ? url : null, tokenSet };
}

/** `GET /user/calendar`'s `bot_name`, or `null` when the answer carries none. */
export function parseDefaultBotName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const name = (raw as Record<string, unknown>).bot_name;
  return typeof name === "string" && name.trim() ? name : null;
}

/** An http(s) URL with a host, within the producer's length limit — admin-api's own rule for
 *  `url`, checked here so a typo is explained before it is sent. */
export function isBackendUrl(value: string): boolean {
  if (value.length > SETTING_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
}

/** The form's input, checked against what is saved, turned into the one `PUT` body that makes it
 *  so — or the sentence that says why not.
 *
 *  A token belongs to the endpoint it was given for. Saving a token with no endpoint, keeping a
 *  token while switching back to the deployment's service, or keeping it for a different URL would
 *  hand that token to a backend it was never meant for, so none is a body this function produces:
 *  a token always travels with its URL, a new URL without a new token clears the old one, and
 *  switching back clears both. */
export function planBackendSave(
  saved: TranscriptionBackend,
  form: { url: string; token: string },
): { ok: true; body: { url?: string; token?: string } } | { ok: false; message: string } {
  const url = form.url.trim();
  const token = form.token.trim();
  if (!url) {
    if (token) return { ok: false, message: "Enter the endpoint's URL — a token is only used with your own endpoint." };
    if (!saved.url && !saved.tokenSet) return { ok: false, message: "Enter your endpoint's URL." };
    return { ok: true, body: { url: "", token: "" } };
  }
  if (!isBackendUrl(url)) return { ok: false, message: "Enter an http:// or https:// URL." };
  if (token.length > SETTING_MAX) return { ok: false, message: `Keep the token to ${SETTING_MAX} characters or fewer.` };
  if (token) return { ok: true, body: { url, token } };
  if (url === saved.url) return { ok: false, message: "Nothing to save — this is already your endpoint." };
  // A new endpoint without a new token: the saved token was for the old one, so it goes.
  return { ok: true, body: saved.tokenSet ? { url, token: "" } : { url } };
}

/** `PUT /user/transcription`'s admitted bodies through the dashboard: only `url` and `token`, both
 *  strings within the producer's limit; a non-empty `url` must be an http(s) URL; a non-empty
 *  `token` must travel with a non-empty `url`; and clearing `url` must clear `token` too. So the
 *  proxy can never be used to leave a customer token behind for the deployment's own service. */
export function isTranscriptionBackendBody(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((k) => k !== "url" && k !== "token")) return false;
  for (const k of keys) {
    const v = body[k];
    if (typeof v !== "string" || v.length > SETTING_MAX) return false;
  }
  const url = body.url as string | undefined;
  const token = body.token as string | undefined;
  if (url !== undefined && url !== "" && !isBackendUrl(url.trim())) return false;
  if (token !== undefined && token !== "" && !(url !== undefined && url.trim() !== "")) return false;
  if (url === "" && token !== "") return false;
  return true;
}
