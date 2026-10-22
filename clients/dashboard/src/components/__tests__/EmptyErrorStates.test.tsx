/** Every data surface keeps its three non-data answers apart: loading, "could not ask" (a failed
 *  read, with a retry) and "you have none" (an empty answer, naming the next action). Rendered
 *  against a mocked `fetch`; plain DOM assertions, as in `MeetingDetail.test.tsx`. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { EmptyState } from "../EmptyState";
import { emptyListCopy } from "../MeetingsView";
import { Participants } from "../Participants";
import { AudioPlayer } from "../AudioPlayer";
import { UpcomingView } from "../UpcomingView";
import { BillingView } from "../BillingView";
import { ToastProvider } from "../ui";
import type { Meeting } from "@/lib/meetings";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EmptyState", () => {
  it("renders the next action under the hint", () => {
    render(<EmptyState title="Nothing here." hint="Do the thing." action={<button type="button">Do it</button>} />);
    expect(screen.getByText("Nothing here.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Do it" })).not.toBeNull();
  });
});

describe("emptyListCopy", () => {
  it("an account with no meetings is told to send a bot", () => {
    expect(emptyListCopy({ query: "", tag: null, tab: "all" })).toMatchObject({ title: "No meetings yet.", action: "send-bot" });
  });

  it("a filter that matched nothing offers to search everything, not to send a bot", () => {
    expect(emptyListCopy({ query: "acme", tag: null, tab: "all" }).action).toBe("search");
  });

  it("a tag with no meetings names the tag and offers the unfiltered list", () => {
    expect(emptyListCopy({ query: "", tag: "acme", tab: "all" })).toMatchObject({
      title: "No meetings tagged “acme”.",
      action: "clear-tag",
    });
  });

  it("each phase tab says what is missing in its own words", () => {
    expect(emptyListCopy({ query: "", tag: null, tab: "live" }).title).toBe("No meetings are live right now.");
    expect(emptyListCopy({ query: "", tag: null, tab: "past" }).title).toBe("No past meetings yet.");
    expect(emptyListCopy({ query: "", tag: null, tab: "scheduled" })).toMatchObject({
      title: "Nothing scheduled.",
      action: "connect-calendar",
    });
  });
});

const MEETING = {
  id: "42",
  platformId: "google_meet",
  nativeId: "abc-defg-hij",
} as unknown as Meeting;

describe("Participants", () => {
  it("a failed roster read says so with a retry, and the retry renders the roster", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ detail: "boom" }, 503)
        : jsonResponse({ participants: [{ name: "Amy", email: null, source: "speaker" }] });
    }));
    render(<Participants meeting={MEETING} />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't load participants/);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading participants" }));
    expect(await screen.findByText("Amy")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["an empty roster", () => jsonResponse({ participants: [] })],
    ["a 404 (the route's answer when it holds no roster)", () => jsonResponse({ detail: "Meeting not found" }, 404)],
  ])("%s renders nothing and no alert", async (_label, answer) => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<Participants meeting={MEETING} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

describe("AudioPlayer", () => {
  it("a recording with no audio file is an answer, not an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ media_file_id: null })));
    render(<AudioPlayer recordingId="7" />);
    expect(await screen.findByText("This meeting has no audio to play.")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed read is an error with a retry", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ detail: "boom" }, 503) : jsonResponse({ media_file_id: 3 });
    }));
    const { container } = render(<AudioPlayer recordingId="7" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't load the recording/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
  });
});

describe("UpcomingView", () => {
  it("Sync now with an unreadable calendar roster reports the failure, never 'no calendars connected'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith("/api/vexa/meetings")) return jsonResponse({ meetings: [] });
      if (url === "/api/vexa/user/calendars") return jsonResponse({ detail: "boom" }, 503);
      return jsonResponse({ error: "unexpected_url", url }, 404);
    }));
    render(<UpcomingView />, { wrapper: ToastProvider });

    expect(await screen.findByText("No upcoming meetings")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Connect a calendar" }).getAttribute("href")).toBe("/calendar");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Couldn't read your calendars")).not.toBeNull();
    expect(screen.queryByText("No calendars connected")).toBeNull();
  });
});

describe("BillingView", () => {
  it("a failed plan read offers a retry, and the retry renders the plan", async () => {
    let entitlementCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url === "/api/vexa/user/entitlements") {
        entitlementCalls += 1;
        if (entitlementCalls === 1) return jsonResponse({ detail: "boom" }, 503);
        return jsonResponse({
          plan_id: "free",
          catalog_version: "test",
          status: null,
          will_renew: false,
          grace_until: null,
          limits: {
            meetings_per_month: 5,
            max_minutes_per_meeting: 60,
            concurrent_bots: 1,
            recording_retention_days: 7,
            ai_summaries_per_month: null,
          },
          usage: { meetings_used: 1, minutes_used: 10 },
          period: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
          subscription: null,
        });
      }
      if (url === "/api/vexa/billing/prices") return jsonResponse({ prices: [] });
      return jsonResponse({ error: "unexpected_url", url }, 404);
    }));
    render(<BillingView />, { wrapper: ToastProvider });

    expect(await screen.findByText(/vexa backend is unreachable/i)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Free plan")).not.toBeNull();
  });
});
