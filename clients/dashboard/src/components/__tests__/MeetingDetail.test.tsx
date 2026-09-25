/** The detail page's whole point: one request names the meeting, and the two failure modes a
 *  404 and a 5xx must not collapse into each other. Rendered against a mocked `fetch` so no
 *  network call escapes.
 *
 *  No `@testing-library/jest-dom` matchers here — the package isn't a devDependency of this
 *  workspace, so assertions use plain DOM truthiness (`getBy*` throws if absent; `queryBy*`
 *  returns null) instead of `toBeInTheDocument()`. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// MeetingDetail's delete flow (DB-42) navigates away with `useRouter()` from `next/navigation`,
// which throws outside an actual App Router tree ("invariant expected app router to be
// mounted"). Every other component under test here renders under plain RTL, not Next's router,
// so the hook is stubbed the same way `next/link` already resolves fine without one.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { MeetingDetail } from "../MeetingDetail";
import { ToastProvider } from "../ui";

// MeetingActions/BotControls now call useToast() (DB-41/DB-42), which throws outside a
// <ToastProvider> exactly like `next/navigation`'s router does — same reason, same fix as
// `SendBotDialog.test.tsx`.
function renderDetail(meetingId: string) {
  return render(<MeetingDetail meetingId={meetingId} />, { wrapper: ToastProvider });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ROW = {
  id: 42,
  platform: "google_meet",
  native_meeting_id: "abc-defg-hij",
  status: "completed",
  shared: false,
  start_time: "2026-09-18T09:00:00Z",
  end_time: "2026-09-18T09:30:00Z",
  data: { title: "Weekly sync" },
};

describe("MeetingDetail", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("fetches the single meeting row by id — never the full list", async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/vexa/meetings/42")) return jsonResponse(ROW);
      if (url.includes("/api/vexa/transcripts/by-id/42")) return jsonResponse({ segments: [] });
      return jsonResponse({ error: "unexpected_url", url }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDetail("42");

    expect(await screen.findByText("Weekly sync")).not.toBeNull();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes("/api/vexa/meetings/42"))).toBe(true);
    expect(urls.some((u) => u === "/api/vexa/meetings" || u.endsWith("/api/vexa/meetings"))).toBe(false);
  });

  it("renders the not-found state on a 404 — this row is not yours or does not exist", async () => {
    fetchMock = vi.fn(async () => jsonResponse({ detail: "Meeting not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    renderDetail("999");

    expect(await screen.findByText(/isn't in your list/i)).not.toBeNull();
  });

  it("renders the error state with retry on a 5xx — 'we could not ask' is not 'you have none'", async () => {
    fetchMock = vi.fn(async () => jsonResponse({ detail: "boom" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    renderDetail("42");

    expect(await screen.findByText(/vexa backend is unreachable/i)).not.toBeNull();
    expect(screen.getByRole("button", { name: /try again/i })).not.toBeNull();
    expect(screen.queryByText(/isn't in your list/i)).toBeNull();
  });

  it("renders the error state on a network failure, distinct from not-found", async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDetail("42");

    expect(await screen.findByText(/couldn't reach the dashboard server/i)).not.toBeNull();
    expect(screen.queryByText(/isn't in your list/i)).toBeNull();
  });
});
