/** The first-run welcome's shapes and pure rules.
 *
 *  Dependency-free like `upstream.ts` and `entitlements.ts`, so the rules are tested directly
 *  rather than through a rendered page. The state itself is the producer's: admin-api's
 *  `GET/PUT /user/first-run` (`first_run.py`) keeps which step a new account is on and whether the
 *  welcome ended, so it follows the person across browsers. This file only decides what the client
 *  does with that answer.
 *
 *  The bot's display name is NOT a first-run field. It is the person's default bot name
 *  (`users.data.calendar_bot_name`, read and written through `GET/PUT /user/calendar`), the one
 *  store meetings resolves when a bot is dispatched without a name of its own — so a name chosen in
 *  the welcome is the same name a later settings page edits.
 */

/** The welcome's steps, in order — admin-api's `first_run.STEPS`. */
export const FIRST_RUN_STEPS = ["name", "calendar", "meeting"] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/** `active` is the only state that shows the welcome; `none` is an account that is not new. */
export type FirstRunState = "active" | "done" | "skipped" | "none";
const STATES: readonly string[] = ["active", "done", "skipped", "none"];

export interface FirstRunStatus {
  state: FirstRunState;
  step: FirstRunStep;
}

export const STEP_LABEL: Record<FirstRunStep, string> = {
  name: "Bot name",
  calendar: "Calendar",
  meeting: "First meeting",
};

function isStep(v: unknown): v is FirstRunStep {
  return typeof v === "string" && (FIRST_RUN_STEPS as readonly string[]).includes(v);
}

/** `GET /user/first-run`'s body, or `null` when it is not that shape — a client that cannot read
 *  the answer shows no welcome, it never guesses one. */
export function parseFirstRunStatus(raw: unknown): FirstRunStatus | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { state, step } = raw as Record<string, unknown>;
  if (typeof state !== "string" || !STATES.includes(state) || !isStep(step)) return null;
  return { state: state as FirstRunState, step };
}

/** Whether the welcome opens. The producer says the account is new and unfinished (`active`); the
 *  meetings count is the client's own knowledge and adds the rest:
 *
 *   - at the first step, the account must have no meetings — a new account that already has some
 *     (a teammate shared one) has nothing left to be welcomed into;
 *   - past the first step the person has already started, and what they started can create
 *     meetings (a connected calendar imports its events), so the count no longer decides.
 *
 *  `meetingCount` is `null` when it could not be read: unknown is not zero, so no welcome. */
export function wizardShouldShow(status: FirstRunStatus | null, meetingCount: number | null): boolean {
  if (!status || status.state !== "active") return false;
  if (status.step !== FIRST_RUN_STEPS[0]) return true;
  return meetingCount === 0;
}

export function stepIndex(step: FirstRunStep): number {
  return FIRST_RUN_STEPS.indexOf(step);
}

/** The longest default bot name the dashboard will send; admin-api's own person-settings
 *  vocabulary truncates at the same length. */
export const BOT_NAME_MAX = 64;

/** A bot name as a person typed it, checked: trimmed, non-empty, within `BOT_NAME_MAX`. */
export function checkBotName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim();
  if (!name) return { ok: false, message: "Give the bot a name — it's what people in the meeting will see." };
  if (name.length > BOT_NAME_MAX) {
    return { ok: false, message: `Keep the name to ${BOT_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, name };
}

/** `PUT /user/calendar`'s ONLY admitted body through the dashboard: exactly the key `bot_name`, a
 *  string within the limit. The producer's route also takes `ics_url` and `auto_join`; this
 *  allowlist admits neither, so the entry can never become a way to rewrite a calendar feed. */
export function isBotNameBody(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "bot_name") return false;
  const name = (parsed as Record<string, unknown>).bot_name;
  return typeof name === "string" && name.trim().length > 0 && name.length <= BOT_NAME_MAX;
}

/** `PUT /user/first-run`'s admitted bodies: a `step`, or a `state` of `done` / `skipped`, or both —
 *  exactly the producer's vocabulary and nothing else. */
export function isFirstRunBody(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((k) => k !== "step" && k !== "state")) return false;
  if ("step" in body && !isStep(body.step)) return false;
  if ("state" in body && body.state !== "done" && body.state !== "skipped") return false;
  return true;
}
