/** The transcription settings page, weighted towards what it REFUSES: what the proxy will not
 *  forward on the two new routes, which saves the form will not plan, and which answers it will
 *  not read as "not configured". */
import { describe, expect, it } from "vitest";
import { resolveUpstream, resolveWriteUpstream, validateBody } from "../upstream";
import {
  SETTING_MAX,
  isBackendUrl,
  isTranscriptionBackendBody,
  parseDefaultBotName,
  parseTranscriptionBackend,
  planBackendSave,
} from "../transcriptionSettings";

describe("the proxy's transcription routes", () => {
  it("admits GET and PUT on exactly /user/transcription", () => {
    expect(resolveUpstream(["user", "transcription"])).toEqual({ path: "/user/transcription" });
    expect(resolveWriteUpstream("PUT", ["user", "transcription"])).toEqual({
      path: "/user/transcription",
      body: expect.any(Function),
    });
  });

  it("refuses near-miss paths and every other method", () => {
    for (const path of [
      ["user", "transcription", "x"], ["user", "transcriptions"], ["transcription"], ["user", "models"],
      ["user", "transcription", ".."], ["user", "Transcription"],
    ]) {
      expect(resolveUpstream(path)).toBeNull();
      expect(resolveWriteUpstream("PUT", path)).toBeNull();
    }
    for (const method of ["POST", "PATCH", "DELETE", "GET"]) {
      expect(resolveWriteUpstream(method, ["user", "transcription"])).toBeNull();
    }
  });

  it("forwards only {url, token} bodies that keep a token with its URL", () => {
    const route = resolveWriteUpstream("PUT", ["user", "transcription"])!;
    for (const body of [
      { url: "https://stt.example.test" },
      { url: "http://stt.internal:9000/v1" },
      { url: "https://stt.example.test", token: "test-token" },
      { url: "https://stt.example.test", token: "" },
      { url: "", token: "" },
      { token: "" },
    ]) {
      expect(validateBody(route, JSON.stringify(body))).toBe(true);
    }
    for (const raw of [
      "", "null", "[]", "{}", "not json",
      // a token without the URL it is for, or left behind when the URL is cleared
      JSON.stringify({ token: "test-token" }),
      JSON.stringify({ url: "", token: "test-token" }),
      JSON.stringify({ url: "" }),
      JSON.stringify({ url: "   ", token: "test-token" }),
      // not an http(s) URL with a host
      JSON.stringify({ url: "ftp://stt.example.test" }),
      JSON.stringify({ url: "javascript:alert(1)" }),
      JSON.stringify({ url: "stt.example.test" }),
      JSON.stringify({ url: "https://" }),
      // wrong types, over the limit, keys the route does not take through here
      JSON.stringify({ url: 7 }), JSON.stringify({ url: null }),
      JSON.stringify({ url: "https://stt.example.test", token: 7 }),
      JSON.stringify({ url: `https://stt.example.test/${"x".repeat(SETTING_MAX)}` }),
      JSON.stringify({ url: "https://stt.example.test", token: "x".repeat(SETTING_MAX + 1) }),
      JSON.stringify({ url: "https://stt.example.test", model: "whisper-1" }),
      JSON.stringify({ url: "https://stt.example.test", user_id: 2 }),
    ]) {
      expect(validateBody(route, raw)).toBe(false);
    }
  });

  it("is the same rule as the exported validator", () => {
    expect(isTranscriptionBackendBody({ url: "https://a.test", token: "t" })).toBe(true);
    expect(isTranscriptionBackendBody({ token: "t" })).toBe(false);
  });
});

describe("parseTranscriptionBackend", () => {
  it("reads a configured and an unconfigured account", () => {
    expect(parseTranscriptionBackend({ url: "https://a.test", token_set: true, token: "********abcd" })).toEqual({
      url: "https://a.test",
      tokenSet: true,
    });
    expect(parseTranscriptionBackend({ url: null, token_set: false, token: null })).toEqual({ url: null, tokenSet: false });
    expect(parseTranscriptionBackend({ url: "", token_set: false })).toEqual({ url: null, tokenSet: false });
  });

  it("never carries the masked token value", () => {
    const parsed = parseTranscriptionBackend({ url: "https://a.test", token_set: true, token: "********abcd" });
    expect(JSON.stringify(parsed)).not.toContain("abcd");
  });

  it("refuses an answer it cannot read rather than calling it unconfigured", () => {
    for (const raw of [null, undefined, [], "x", 1, {}, { url: 1, token_set: false }, { url: null }, { url: null, token_set: "no" }]) {
      expect(parseTranscriptionBackend(raw)).toBeNull();
    }
  });
});

describe("parseDefaultBotName", () => {
  it("reads bot_name from GET /user/calendar", () => {
    expect(parseDefaultBotName({ ics_url_set: false, bot_name: "Scribe" })).toBe("Scribe");
  });

  it("refuses an answer without a usable name", () => {
    for (const raw of [null, [], {}, { bot_name: "" }, { bot_name: "  " }, { bot_name: 7 }]) {
      expect(parseDefaultBotName(raw)).toBeNull();
    }
  });
});

describe("isBackendUrl", () => {
  it("admits http(s) URLs with a host and nothing else", () => {
    expect(isBackendUrl("https://stt.example.test/v1")).toBe(true);
    expect(isBackendUrl("http://10.0.0.5:9000")).toBe(true);
    for (const v of ["", "stt.example.test", "ftp://a.test", "file:///etc/passwd", "https://", "data:text/plain,x"]) {
      expect(isBackendUrl(v)).toBe(false);
    }
  });
});

describe("planBackendSave", () => {
  const vexa = { url: null, tokenSet: false };
  const mine = { url: "https://stt.example.test", tokenSet: true };

  it("sets an endpoint, with or without a token", () => {
    expect(planBackendSave(vexa, { url: " https://stt.example.test ", token: "" })).toEqual({
      ok: true,
      body: { url: "https://stt.example.test" },
    });
    expect(planBackendSave(vexa, { url: "https://stt.example.test", token: " test-token " })).toEqual({
      ok: true,
      body: { url: "https://stt.example.test", token: "test-token" },
    });
  });

  it("sends a new token together with the URL it is for", () => {
    expect(planBackendSave(mine, { url: "https://stt.example.test", token: "rotated" })).toEqual({
      ok: true,
      body: { url: "https://stt.example.test", token: "rotated" },
    });
  });

  it("clears the saved token when the URL changes without a new one", () => {
    expect(planBackendSave(mine, { url: "https://other.example.test", token: "" })).toEqual({
      ok: true,
      body: { url: "https://other.example.test", token: "" },
    });
  });

  it("switching back to the deployment's service clears both", () => {
    expect(planBackendSave(mine, { url: "", token: "" })).toEqual({ ok: true, body: { url: "", token: "" } });
  });

  it("refuses a token without a URL, a bad URL, an over-long token, and a no-op", () => {
    for (const [saved, form] of [
      [vexa, { url: "", token: "test-token" }],
      [mine, { url: "  ", token: "test-token" }],
      [vexa, { url: "", token: "" }],
      [vexa, { url: "stt.example.test", token: "" }],
      [vexa, { url: "ftp://stt.example.test", token: "" }],
      [vexa, { url: "https://stt.example.test", token: "x".repeat(SETTING_MAX + 1) }],
      [mine, { url: "https://stt.example.test", token: "" }],
    ] as const) {
      const plan = planBackendSave(saved, form);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.message.length).toBeGreaterThan(0);
    }
  });

  it("never plans a body the proxy would refuse", () => {
    const forms = [
      { url: "https://a.test", token: "" }, { url: "https://a.test", token: "t" },
      { url: "https://b.test", token: "" }, { url: "", token: "" },
    ];
    for (const saved of [vexa, mine, { url: "https://a.test", tokenSet: false }]) {
      for (const form of forms) {
        const plan = planBackendSave(saved, form);
        if (plan.ok) expect(isTranscriptionBackendBody(plan.body)).toBe(true);
      }
    }
  });
});
