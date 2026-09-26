/** `fetchTrustedAuthorizeUrl` is the ONE place both providers' authorize call and its host check
 *  run — every caller (`SendBotDialog`'s connect buttons, `CalendarHealthView`'s Reconnect
 *  action) depends on this refusing a malformed or wrong-host response rather than navigating a
 *  signed-in user's browser to it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_OAUTH_LABEL, fetchTrustedAuthorizeUrl } from "../calendarOAuth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTrustedAuthorizeUrl", () => {
  it("returns the authorize_url when it is the real Google consent-screen host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x", state: "a.b" }),
    ));
    await expect(fetchTrustedAuthorizeUrl("google")).resolves.toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    );
  });

  it("returns the authorize_url when it is the real Microsoft consent-screen host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x", state: "a.b" }),
    ));
    await expect(fetchTrustedAuthorizeUrl("microsoft")).resolves.toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
    );
  });

  it("throws a reader-facing message when the host is wrong for the requested provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ authorize_url: "https://evil.example.com/phish", state: "a.b" }),
    ));
    await expect(fetchTrustedAuthorizeUrl("google")).rejects.toThrow(/unexpected link/);
  });

  it("refuses Google's host when Microsoft was requested, and vice versa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ authorize_url: "https://accounts.google.com/o/oauth2/v2/auth", state: "a.b" }),
    ));
    await expect(fetchTrustedAuthorizeUrl("microsoft")).rejects.toThrow(/unexpected link/);
  });

  it("propagates a network/HTTP failure as-is (ApiError from getJson)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "not configured" }, 503)));
    await expect(fetchTrustedAuthorizeUrl("google")).rejects.toThrow();
  });
});

describe("CALENDAR_OAUTH_LABEL", () => {
  it("names both shipped providers", () => {
    expect(CALENDAR_OAUTH_LABEL.google).toBe("Google Calendar");
    expect(CALENDAR_OAUTH_LABEL.microsoft).toBe("Microsoft 365");
  });
});
