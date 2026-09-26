/** The "Add a Bot" modal is the browser-side half of the write surface (`lib/upstream.ts`
 *  covers the server side). Rendered against a mocked `fetch` so no network call escapes.
 *
 *  No `@testing-library/jest-dom` matchers here — the package isn't a devDependency of this
 *  workspace, so assertions use plain DOM truthiness (`getBy*` throws if absent; `queryBy*`
 *  returns null) instead of `toBeInTheDocument()`. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SendBotDialog } from "../SendBotDialog";
import { ToastProvider } from "../ui";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// DB-04: SendBotDialog's bot-send and calendar mutations now confirm/fail through `useToast()`,
// which throws outside a `ToastProvider`. Every render below needs the same provider `app/layout.tsx`
// mounts in the real app — wrapping here is infrastructure, not a loosened assertion.
function renderDialog(props: { onClose: () => void; onBotSent: () => void }) {
  return render(<SendBotDialog {...props} />, { wrapper: ToastProvider });
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
              kind: "ics",
              name: "Work calendar",
              ics_url_set: true,
              ics_url_masked: "https://calendar.example.com/***.ics",
              auto_join: true,
              enabled: true,
            },
          ],
        });
      }
      if (url.includes("/api/vexa/bots")) {
        return jsonResponse({ id: 901, status: "requested", platform: "google_meet", native_meeting_id: "abc-defg-hij" });
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
    renderDialog({ onClose: () => {}, onBotSent: () => {} });
    expect(screen.getByRole("dialog", { name: /add a vexa bot/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /meeting link/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^calendar$/i })).not.toBeNull();
    expect(screen.getByLabelText(/meeting url/i)).not.toBeNull();
  });

  it("surfaces the parsed platform chip and enables Send for a valid Meet URL", async () => {
    renderDialog({ onClose: () => {}, onBotSent: () => {} });

    const input = screen.getByLabelText(/meeting url/i) as HTMLInputElement;
    const sendButton = screen.getByRole("button", { name: /send bot/i }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "https://meet.google.com/abc-defg-hij" } });

    expect(await screen.findByText(/google meet/i)).not.toBeNull();
    expect(screen.getByText(/abc-defg-hij/i)).not.toBeNull();
    await waitFor(() => expect(sendButton.disabled).toBe(false));
  });

  it("leaves Send disabled for an unparseable URL", async () => {
    renderDialog({ onClose: () => {}, onBotSent: () => {} });

    const input = screen.getByLabelText(/meeting url/i) as HTMLInputElement;
    const sendButton = screen.getByRole("button", { name: /send bot/i }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "https://example.com/not-a-meeting" } });

    expect(sendButton.disabled).toBe(true);
    expect(screen.queryByText(/paste a google meet, zoom, teams, or jitsi link/i)).not.toBeNull();
    expect(screen.queryByText(/^google meet$/i)).toBeNull();
  });

  it("shows the confirmation after Send Bot, surviving the URL field's own clear", async () => {
    // Regression: `send()` sets the success result then clears `url` so another link can be
    // pasted. The parse effect used to key its `setResult(null)` off `url` itself, so that
    // programmatic clear fired the very next render and erased the confirmation before anyone
    // could see it — this test is red without the fix in ../SendBotDialog.tsx.
    renderDialog({ onClose: () => {}, onBotSent: () => {} });

    const input = screen.getByLabelText(/meeting url/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://meet.google.com/abc-defg-hij" } });
    await waitFor(() => expect((screen.getByRole("button", { name: /send bot/i }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /send bot/i }));

    // DB-04: the same confirmation text now also appears in a toast (a sibling of the dialog,
    // pushed via `useToast()`) — scope to the dialog so this asserts the inline banner
    // specifically, the thing the regression this test guards against actually erased.
    const dialog = within(screen.getByRole("dialog"));
    expect(await dialog.findByText("Bot is joining the meeting.")).not.toBeNull();
    expect(input.value).toBe("");
    // Give any stray effect a chance to run before asserting the message is still there.
    await waitFor(() => expect(dialog.getByText("Bot is joining the meeting.")).not.toBeNull());
  });

  it("clears a prior result as soon as the user edits the URL themselves", async () => {
    renderDialog({ onClose: () => {}, onBotSent: () => {} });

    const dialog = within(screen.getByRole("dialog"));
    const input = screen.getByLabelText(/meeting url/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://meet.google.com/abc-defg-hij" } });
    await waitFor(() => expect((screen.getByRole("button", { name: /send bot/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /send bot/i }));
    await dialog.findByText("Bot is joining the meeting.");

    fireEvent.change(input, { target: { value: "https://meet.google.com/another-one" } });

    // Scoped to the dialog (see above) — the toast pushed by the same send is a separate,
    // independently-timed piece of UI and is allowed to still be on screen here.
    expect(dialog.queryByText("Bot is joining the meeting.")).toBeNull();
  });

  it("lists calendar connections from /api/vexa/user/calendars on the Calendar tab", async () => {
    renderDialog({ onClose: () => {}, onBotSent: () => {} });

    fireEvent.click(screen.getByRole("button", { name: /^calendar$/i }));

    expect(await screen.findByText("Work calendar")).not.toBeNull();
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/vexa/user/calendars")),
    ).toBe(true);
  });

  // DB-31: Google Calendar connect is the primary path; Microsoft 365 (DB-32) is not shipped as
  // a disabled placeholder — AGENTS.md's "never ship a placeholder" rule.
  it("shows Connect Google Calendar as the primary calendar action, with no Microsoft placeholder", async () => {
    renderDialog({ onClose: () => {}, onBotSent: () => {} });

    fireEvent.click(screen.getByRole("button", { name: /^calendar$/i }));

    expect(await screen.findByRole("button", { name: /connect google calendar/i })).not.toBeNull();
    // Outlook/Microsoft 365 is legitimately named as an ICS-fallback provider in the inline
    // guide — what must NOT exist is a "Connect Microsoft 365" action of its own (DB-32) or a
    // disabled "coming soon" placeholder for it.
    expect(screen.queryByRole("button", { name: /connect microsoft/i })).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it("shows a Reconnect action for a Google connection whose grant needs reconnecting", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/vexa/meeting/jitsi-hosts")) return jsonResponse({ hosts: [] });
      if (url.includes("/api/vexa/user/calendars")) {
        return jsonResponse({
          calendars: [
            {
              id: "cal-g1",
              kind: "google",
              name: "Google — person@example.com",
              google_email: "person@example.com",
              google_calendar_ids: ["primary"],
              reconnect_needed: true,
              auto_join: true,
              enabled: true,
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected_url", url }, 404);
    });

    renderDialog({ onClose: () => {}, onBotSent: () => {} });
    fireEvent.click(screen.getByRole("button", { name: /^calendar$/i }));

    expect(await screen.findByText(/reconnect needed/i)).not.toBeNull();
    expect(screen.getByRole("button", { name: /^reconnect$/i })).not.toBeNull();
  });
});
