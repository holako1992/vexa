/** The "Add a Bot" modal is the browser-side half of the write surface (`lib/upstream.ts`
 *  covers the server side). Rendered against a mocked `fetch` so no network call escapes.
 *
 *  No `@testing-library/jest-dom` matchers here — the package isn't a devDependency of this
 *  workspace, so assertions use plain DOM truthiness (`getBy*` throws if absent; `queryBy*`
 *  returns null) instead of `toBeInTheDocument()`. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SendBotDialog } from "../SendBotDialog";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SendBotDialog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/vexa/meeting/jitsi-hosts")) {
        return jsonResponse({ hosts: ["jitsi.example.com"] });
      }
      if (url.includes("/api/vexa/user/calendars")) {
        return jsonResponse({
          calendars: [
            {
              id: "cal-1",
              name: "Work calendar",
              ics_url_set: true,
              ics_url_masked: "https://calendar.example.com/***.ics",
              auto_join: true,
              enabled: true,
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected_url", url }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders both tabs, defaulting to the meeting-link tab", () => {
    render(<SendBotDialog onClose={() => {}} onBotSent={() => {}} />);
    expect(screen.getByRole("dialog", { name: /add a vexa bot/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /meeting link/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^calendar$/i })).not.toBeNull();
    expect(screen.getByLabelText(/meeting url/i)).not.toBeNull();
  });

  it("surfaces the parsed platform chip and enables Send for a valid Meet URL", async () => {
    render(<SendBotDialog onClose={() => {}} onBotSent={() => {}} />);

    const input = screen.getByLabelText(/meeting url/i) as HTMLInputElement;
    const sendButton = screen.getByRole("button", { name: /send bot/i }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "https://meet.google.com/abc-defg-hij" } });

    expect(await screen.findByText(/google meet/i)).not.toBeNull();
    expect(screen.getByText(/abc-defg-hij/i)).not.toBeNull();
    await waitFor(() => expect(sendButton.disabled).toBe(false));
  });

  it("leaves Send disabled for an unparseable URL", async () => {
    render(<SendBotDialog onClose={() => {}} onBotSent={() => {}} />);

    const input = screen.getByLabelText(/meeting url/i) as HTMLInputElement;
    const sendButton = screen.getByRole("button", { name: /send bot/i }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "https://example.com/not-a-meeting" } });

    expect(sendButton.disabled).toBe(true);
    expect(screen.queryByText(/paste a google meet, zoom, teams, or jitsi link/i)).not.toBeNull();
    expect(screen.queryByText(/^google meet$/i)).toBeNull();
  });

  it("lists calendar connections from /api/vexa/user/calendars on the Calendar tab", async () => {
    render(<SendBotDialog onClose={() => {}} onBotSent={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^calendar$/i }));

    expect(await screen.findByText("Work calendar")).not.toBeNull();
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/vexa/user/calendars")),
    ).toBe(true);
  });
});
