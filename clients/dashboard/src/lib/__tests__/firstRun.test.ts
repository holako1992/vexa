/** The first-run welcome, weighted towards what it REFUSES: who is not shown it, what the proxy
 *  will not forward on its two new write routes, and a state the client cannot read. */
import { describe, expect, it } from "vitest";
import {
  BOT_NAME_MAX,
  FIRST_RUN_STEPS,
  checkBotName,
  isBotNameBody,
  isFirstRunBody,
  parseFirstRunStatus,
  wizardShouldShow,
} from "../firstRun";
import { resolveUpstream, resolveWriteUpstream, validateBody } from "../upstream";

describe("parseFirstRunStatus", () => {
  it("reads the producer's answer", () => {
    expect(parseFirstRunStatus({ state: "active", step: "calendar" })).toEqual({ state: "active", step: "calendar" });
    for (const state of ["active", "done", "skipped", "none"]) {
      expect(parseFirstRunStatus({ state, step: "name" })?.state).toBe(state);
    }
  });

  it("refuses anything that is not that shape, so an unreadable answer shows no welcome", () => {
    for (const raw of [
      null, undefined, "active", 7, [], {},
      { state: "active" }, { step: "name" },
      { state: "pending", step: "name" }, { state: "active", step: "billing" },
      { state: 1, step: "name" }, { state: "active", step: 0 },
    ]) {
      expect(parseFirstRunStatus(raw)).toBeNull();
    }
  });
});

describe("wizardShouldShow", () => {
  const at = (state: string, step: string) => parseFirstRunStatus({ state, step });

  it("welcomes a new account with no meetings", () => {
    expect(wizardShouldShow(at("active", "name"), 0)).toBe(true);
  });

  it("does not welcome a new account that already has meetings, or whose count is unknown", () => {
    expect(wizardShouldShow(at("active", "name"), 3)).toBe(false);
    expect(wizardShouldShow(at("active", "name"), null)).toBe(false);
  });

  it("does not welcome an account that is not new, however empty its list", () => {
    expect(wizardShouldShow(at("none", "name"), 0)).toBe(false);
  });

  it("never re-opens an ended welcome", () => {
    for (const state of ["done", "skipped"]) {
      for (const step of FIRST_RUN_STEPS) expect(wizardShouldShow(at(state, step), 0)).toBe(false);
    }
  });

  it("does not welcome when there is no status to read", () => {
    expect(wizardShouldShow(null, 0)).toBe(false);
  });

  it("resumes past the first step even though what the person started created meetings", () => {
    expect(wizardShouldShow(at("active", "calendar"), 4)).toBe(true);
    expect(wizardShouldShow(at("active", "meeting"), 4)).toBe(true);
    expect(wizardShouldShow(at("active", "meeting"), null)).toBe(true);
  });
});

describe("checkBotName", () => {
  it("trims and accepts a name within the limit", () => {
    expect(checkBotName("  Scribe  ")).toEqual({ ok: true, name: "Scribe" });
    expect(checkBotName("x".repeat(BOT_NAME_MAX))).toEqual({ ok: true, name: "x".repeat(BOT_NAME_MAX) });
  });

  it("refuses an empty, blank or over-long name in plain words", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      const r = checkBotName(raw);
      expect(r.ok).toBe(false);
    }
    const long = checkBotName("x".repeat(BOT_NAME_MAX + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain(String(BOT_NAME_MAX));
  });
});

describe("the proxy's first-run routes", () => {
  it("reads the two new GET routes and nothing near them", () => {
    expect(resolveUpstream(["user", "calendar"])).toEqual({ path: "/user/calendar" });
    expect(resolveUpstream(["user", "first-run"])).toEqual({ path: "/user/first-run" });
    for (const path of [
      ["user", "first_run"], ["user", "first-run", "x"], ["user", "calendar", "x"],
      ["user", "calendar", "google"], ["first-run"], ["user"], ["user", "first-run", ".."],
    ]) {
      expect(resolveUpstream(path)).toBeNull();
    }
  });

  it("admits PUT on exactly those two paths", () => {
    expect(resolveWriteUpstream("PUT", ["user", "calendar"])?.path).toBe("/user/calendar");
    expect(resolveWriteUpstream("PUT", ["user", "first-run"])?.path).toBe("/user/first-run");
  });

  it("refuses PUT everywhere else, and every other method on those paths", () => {
    for (const path of [
      ["user", "calendars"], ["user", "calendars", "cal-1"], ["user", "models"], ["user", "transcription"],
      ["user", "webhook"], ["user", "entitlements"], ["bots"], ["meetings", "1"], ["user", "calendar", "x"],
      ["user", "first-run", "x"], [],
    ]) {
      expect(resolveWriteUpstream("PUT", path)).toBeNull();
    }
    for (const method of ["POST", "PATCH", "DELETE", "GET"]) {
      expect(resolveWriteUpstream(method, ["user", "first-run"])).toBeNull();
      expect(resolveWriteUpstream(method, ["user", "calendar"])).toBeNull();
    }
  });

  it("forwards only a bot_name body on PUT /user/calendar", () => {
    const route = resolveWriteUpstream("PUT", ["user", "calendar"])!;
    expect(validateBody(route, JSON.stringify({ bot_name: "Scribe" }))).toBe(true);
    for (const raw of [
      "", "null", "[]", "{}", "not json",
      JSON.stringify({ bot_name: "" }), JSON.stringify({ bot_name: "   " }),
      JSON.stringify({ bot_name: 7 }), JSON.stringify({ bot_name: null }),
      JSON.stringify({ bot_name: "x".repeat(BOT_NAME_MAX + 1) }),
      // the producer's route also takes these — the dashboard must not reach them through here
      JSON.stringify({ ics_url: null }), JSON.stringify({ auto_join: false }),
      JSON.stringify({ bot_name: "Scribe", ics_url: null }),
      JSON.stringify({ bot_name: "Scribe", auto_join: false }),
    ]) {
      expect(validateBody(route, raw)).toBe(false);
    }
  });

  it("forwards only the producer's own vocabulary on PUT /user/first-run", () => {
    const route = resolveWriteUpstream("PUT", ["user", "first-run"])!;
    for (const body of [{ step: "calendar" }, { step: "meeting" }, { state: "done" }, { state: "skipped" }, { step: "name", state: "skipped" }]) {
      expect(validateBody(route, JSON.stringify(body))).toBe(true);
    }
    for (const raw of [
      "", "null", "[]", "{}", "nope",
      JSON.stringify({ step: "billing" }), JSON.stringify({ step: 1 }), JSON.stringify({ step: null }),
      JSON.stringify({ state: "active" }), JSON.stringify({ state: "none" }), JSON.stringify({ state: "" }),
      JSON.stringify({ state: ["done"] }),
      JSON.stringify({ user_id: 1 }), JSON.stringify({ step: "name", extra: true }),
    ]) {
      expect(validateBody(route, raw)).toBe(false);
    }
  });

  it("the body checks are pure functions of the parsed value", () => {
    expect(isBotNameBody(undefined)).toBe(false);
    expect(isFirstRunBody(undefined)).toBe(false);
    expect(isBotNameBody({ bot_name: "ok" })).toBe(true);
    expect(isFirstRunBody({ state: "done" })).toBe(true);
  });
});
