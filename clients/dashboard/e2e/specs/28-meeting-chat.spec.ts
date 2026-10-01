/** The assistant chat — "Ask about this meeting" on the meeting page and "Ask across all my
 *  meetings" on the search page — against the stub's `/agent/chat`, which answers the way the
 *  gateway relays agent-api (`stub-server.mjs`'s `answerChat`).
 *
 *  Expected:
 *   - an answer renders while its stream is still open (first words, then the rest after the
 *     stub is released), with `**strong**` as a real <strong>;
 *   - the body that reaches the gateway is exactly the meeting-scoped shape for that row;
 *   - Stop closes the stream: the stub sees the connection drop before the turn finished;
 *   - every no-answer case (no model credential, model failure, agent-api not wired, agent-api
 *     down, no agent domain at all) is a sentence on screen, never a spinner;
 *   - New conversation resets that meeting's own thread;
 *   - the search page sends the across-meetings shape (no focus, schedule digest on);
 *   - a meeting shared with the reader has no chat;
 *   - the proxy refuses bodies outside those shapes before anything reaches the gateway;
 *   - the panel works from the keyboard alone.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { GATEWAY_URL } from "../ports.mjs";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

async function chatMode(request: APIRequestContext, mode: string): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/chatMode`, { data: { mode } });
  if (!res.ok()) throw new Error(`stub chat mode failed: ${res.status()}`);
}

async function releaseChat(request: APIRequestContext): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/chatRelease`);
}

async function chatState(request: APIRequestContext): Promise<{ closedEarly: number; finished: number }> {
  return (await (await request.get(`${GATEWAY_URL}/__control/chat`)).json()) as { closedEarly: number; finished: number };
}

async function chatPosts(request: APIRequestContext, path = "/agent/chat") {
  return (await gatewayRequests(request)).filter((r) => r.method === "POST" && r.url === path);
}

async function openMeetingChat(page: Page, id: number) {
  await page.goto(`/meetings/${id}`);
  await page.getByRole("button", { name: "Ask about this meeting" }).click();
  const panel = page.getByRole("complementary", { name: "Chat about this meeting" });
  await expect(panel).toBeVisible();
  return panel;
}

async function ask(panel: ReturnType<Page["getByRole"]>, question: string) {
  await panel.getByRole("textbox", { name: "Ask about this meeting" }).fill(question);
  await panel.getByRole("button", { name: "Ask", exact: true }).click();
}

test("an answer streams in while the turn is open, and the body is the meeting-scoped shape", async ({ page, request }) => {
  await chatMode(request, "hold");
  await signIn(page, testEmail("chat-stream"));
  const panel = await openMeetingChat(page, 102);
  await ask(panel, "What did we decide?");

  const log = panel.getByRole("log", { name: "Conversation" });
  await expect(log.getByText("What did we decide?")).toBeVisible();
  // First words on screen while the stub still holds the stream open.
  await expect(log.getByText("Meeting 102 (completed):", { exact: false })).toBeVisible();
  await expect(log.getByText("Writing…")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Stop" })).toBeVisible();
  expect((await chatState(request)).finished).toBe(0);

  await releaseChat(request);
  await expect(log.getByText(/the team agreed to ship on/)).toBeVisible();
  await expect(log.locator("strong", { hasText: "Friday" })).toBeVisible();
  await expect(log.getByText("Writing…")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(log.locator('[data-chat-turn="done"]')).toHaveCount(1);

  const posts = await chatPosts(request);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({
    prompt: "What did we decide?",
    session: "dashboard-meeting-102",
    context: { focus: { kind: "meeting", meeting_id: "102", platform: "zoom", native_id: "1234567890", status: "completed" } },
  });
  expect(posts[0]!.headers["x-api-key"]).toBeTruthy();
  expect(posts[0]!.headers["cookie"]).toBeUndefined();
});

test("Stop closes the stream before the turn finishes and keeps what arrived", async ({ page, request }) => {
  await chatMode(request, "hold");
  await signIn(page, testEmail("chat-stop"));
  const panel = await openMeetingChat(page, 102);
  await ask(panel, "Summarize it");
  const log = panel.getByRole("log", { name: "Conversation" });
  await expect(log.getByText("Meeting 102 (completed):", { exact: false })).toBeVisible();

  await panel.getByRole("button", { name: "Stop" }).click();
  await expect(log.getByText("Stopped. The answer above is incomplete.")).toBeVisible();
  await expect(log.getByText("Meeting 102 (completed):", { exact: false })).toBeVisible();
  await expect.poll(async () => (await chatState(request)).closedEarly, { timeout: 10_000 }).toBe(1);
  expect((await chatState(request)).finished).toBe(0);
  await expect(panel.getByRole("button", { name: "Ask", exact: true })).toBeVisible();
});

test("every no-answer case is a plain sentence, never a spinner", async ({ page, request }) => {
  await signIn(page, testEmail("chat-failures"));
  const panel = await openMeetingChat(page, 102);
  const log = panel.getByRole("log", { name: "Conversation" });

  const cases: Array<[string, RegExp]> = [
    ["noCredentials", /No model credentials are configured, so the agent cannot run\./],
    ["modelFailure", /The model couldn't answer: Model credentials are missing or expired/],
    ["relayNotWired", /The assistant couldn't answer\. agent-api said: stream relay not wired/],
    ["unreachable", /No answer came back\. The assistant may not be set up on this deployment\./],
    ["absent", /The assistant isn't available on this deployment\./],
  ];
  for (const [mode, sentence] of cases) {
    await chatMode(request, mode);
    await ask(panel, `case ${mode}`);
    await expect(log.getByRole("alert").filter({ hasText: sentence })).toBeVisible();
  }
  await expect(log.getByText(/Working…|Writing…/)).toHaveCount(0);
  await expect(log.locator('[data-chat-turn="failed"]')).toHaveCount(cases.length);
});

test("New conversation resets this meeting's own thread and clears the panel", async ({ page, request }) => {
  await signIn(page, testEmail("chat-reset"));
  const panel = await openMeetingChat(page, 102);
  await ask(panel, "First question");
  const log = panel.getByRole("log", { name: "Conversation" });
  await expect(log.locator("strong", { hasText: "Friday" })).toBeVisible();

  await panel.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByText("Started a new conversation.")).toBeVisible();
  await expect(log.getByText("First question")).toHaveCount(0);
  const resets = await chatPosts(request, "/agent/chat/reset");
  expect(resets.map((r) => r.body)).toEqual([{ session: "dashboard-meeting-102" }]);
});

test("the search page asks across all meetings with no meeting focus", async ({ page, request }) => {
  await signIn(page, testEmail("chat-all"));
  await page.goto("/search");
  await page.getByRole("button", { name: "Ask across all my meetings" }).click();
  const section = page.getByRole("region", { name: "Ask across all my meetings" });
  await section.getByRole("textbox", { name: "Ask across all my meetings" }).fill("Which meetings mentioned Acme?");
  await section.getByRole("textbox", { name: "Ask across all my meetings" }).press("Enter");

  await expect(section.locator("em", { hasText: "Design Review" })).toBeVisible();
  await expect(section.getByText(/Across your meetings: Acme came up in/)).toBeVisible();

  const posts = await chatPosts(request);
  expect(posts).toHaveLength(1);
  const body = posts[0]!.body as { prompt: string; session: string; context: Record<string, unknown> };
  expect(body.prompt).toBe("Which meetings mentioned Acme?");
  expect(body.session).toBe("dashboard-all-meetings");
  expect(body.context.include).toEqual({ schedule: true });
  expect(Object.keys(body.context).sort()).toEqual(expect.arrayContaining(["include"]));
  expect(body.context).not.toHaveProperty("focus");
  expect(Object.keys(body).sort()).toEqual(["context", "prompt", "session"]);
});

test("a meeting shared with the reader has no chat", async ({ page, request }) => {
  await signIn(page, testEmail("chat-shared"));
  await page.goto("/meetings/104");
  await expect(page.getByRole("heading", { name: "Daily Standup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask about this meeting" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Chat about this meeting" })).toHaveCount(0);
  expect(await chatPosts(request)).toHaveLength(0);
});

test("the proxy refuses chat bodies outside the panels' shapes before they reach the gateway", async ({ page, request }) => {
  await signIn(page, testEmail("chat-allowlist"));
  await page.getByRole("heading", { name: "Design Review" }).waitFor();
  const before = (await gatewayRequests(request)).length;

  const focus = { kind: "meeting", meeting_id: "102", platform: "zoom", native_id: "1234567890", status: "completed" };
  const refusedTurns = [
    { prompt: "q", session: "dashboard-meeting-999", context: { focus } }, // session for another row
    { prompt: "q", session: "main", context: { focus } }, // a thread outside the dashboard's own
    { prompt: "q", session: "dashboard-meeting-102", context: { focus }, active: { kind: "meeting", native_id: "x" } },
    { prompt: "q", session: "dashboard-meeting-102", context: { focus: { kind: "workspace", slug: "other-team" } } },
    { prompt: "x".repeat(4001), session: "dashboard-meeting-102", context: { focus } },
    { prompt: "q", session: "dashboard-all-meetings", context: { include: { schedule: true }, focus: null } },
  ];
  for (const data of refusedTurns) {
    const res = await page.request.post("/api/vexa/agent/chat", { data });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  }
  for (const data of [{ session: "main" }, { session: "dashboard-meeting-102", subject: "u_other" }]) {
    const res = await page.request.post("/api/vexa/agent/chat/reset", { data });
    expect(res.status()).toBe(400);
  }
  const get = await page.request.get("/api/vexa/agent/chat");
  expect(get.status()).toBe(404);
  const sessions = await page.request.post("/api/vexa/agent/sessions", { data: {} });
  expect(sessions.status()).toBe(404);

  expect((await gatewayRequests(request)).length).toBe(before);
});

test("the panel opens, asks, and closes from the keyboard", async ({ page, request }) => {
  await signIn(page, testEmail("chat-keyboard"));
  await page.goto("/meetings/102");
  const opener = page.getByRole("button", { name: "Ask about this meeting" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Chat about this meeting" });
  const field = panel.getByRole("textbox", { name: "Ask about this meeting" });
  await expect(field).toBeFocused();
  await page.keyboard.type("Keyboard question");
  await page.keyboard.press("Enter");
  await expect(panel.locator("strong", { hasText: "Friday" })).toBeVisible();
  await expect(field).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(await chatPosts(request)).toHaveLength(1);
});
