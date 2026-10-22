/** The transcription settings page: the default bot name and the transcription service.
 *
 *  Expected: /settings/transcription is reachable from the main navigation and shows the saved
 *  default bot name (`GET /user/calendar`'s `bot_name`) and the saved transcription service
 *  (`GET /user/transcription`). Saving a name writes `PUT /user/calendar {bot_name}` and nothing
 *  else — the same field the first-run welcome writes and the Send Bot form reads, so each one sees
 *  the other's value. The service token is write-only: never shown, never prefilled, and the
 *  masked value the producer returns never reaches the page's text or fields. Switching back to
 *  the deployment's service clears the URL and the token together. A failed read of either store is
 *  "could not ask" with a retry, never a default value, and a refused save is a toast in words.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { GATEWAY_URL } from "../ports.mjs";
import { dispatchedBots, gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

/** Write a store the way another client would: straight to the stub gateway, under a key the stub
 *  does not judge (it only refuses `e2e-token-` keys it has revoked). */
async function seed(request: APIRequestContext, path: string, data: unknown): Promise<void> {
  const res = await request.put(`${GATEWAY_URL}${path}`, { data, headers: { "X-API-Key": "seed-key" } });
  if (!res.ok()) throw new Error(`seed ${path} failed: ${res.status()}`);
}

async function force(request: APIRequestContext, data: Record<string, number | null>): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data });
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Transcription" }).click();
  // The first visit compiles the route under `next dev`; the client-side navigation waits on it.
  await expect(page).toHaveURL(/\/settings\/transcription$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Transcription", level: 1 })).toBeVisible();
}

const SECRET = "test-token-not-real-9f3c";

test("loads the saved bot name and service, and never shows the token", async ({ page, request }) => {
  await seed(request, "/user/calendar", { bot_name: "Scribe" });
  await seed(request, "/user/transcription", { url: "https://stt.example.test/v1", token: SECRET });
  await signIn(page, testEmail("tx-load"));
  await openSettings(page);

  await expect(page.getByLabel("Name")).toHaveValue("Scribe");
  await expect(page.getByTestId("backend-current")).toContainText("Using your endpoint: https://stt.example.test/v1 (token saved)");
  await expect(page.getByLabel("Your endpoint URL")).toHaveValue("https://stt.example.test/v1");
  await expect(page.getByLabel("Token")).toHaveValue("");
  await expect(page.getByLabel("Token")).toHaveAttribute("type", "password");
  await expect(page.getByTestId("language-note")).toBeVisible();

  const text = await page.locator("main").innerText();
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(SECRET.slice(-4));
});

test("an account with nothing saved shows the defaults the producer states", async ({ page }) => {
  await signIn(page, testEmail("tx-defaults"));
  await openSettings(page);
  await expect(page.getByLabel("Name")).toHaveValue("Vexa");
  await expect(page.getByTestId("backend-current")).toHaveText("Using this Vexa's transcription service.");
  await expect(page.getByRole("button", { name: "Use this Vexa's service" })).toHaveCount(0);
});

test("saving the bot name writes the one default field, persists, and the Send Bot form uses it", async ({ page, request }) => {
  await signIn(page, testEmail("tx-name"));
  await openSettings(page);

  await page.getByLabel("Name").fill("  Notetaker  ");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Your bot will join as “Notetaker”.")).toBeVisible();

  const writes = (await gatewayRequests(request)).filter((r) => r.method === "PUT");
  expect(writes.map((r) => [r.url, r.body])).toEqual([["/user/calendar", { bot_name: "Notetaker" }]]);

  await page.reload();
  await expect(page.getByLabel("Name")).toHaveValue("Notetaker");

  // The same field the Send Bot form reads: it says the name, and the dispatch leaves it to the core.
  await page.goto("/");
  await page.getByRole("button", { name: "Add Bot" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await dialog.getByLabel("Meeting URL").fill("https://meet.google.com/abc-defg-hij");
  await expect(dialog.getByText(/appears in the meeting as "Notetaker"/)).toBeVisible();
  await dialog.getByRole("button", { name: "Send Bot" }).click();
  await expect(dialog.getByText("Bot is joining the meeting.")).toBeVisible();
  const bots = await dispatchedBots(request);
  expect(bots).toHaveLength(1);
  expect(bots[0]).not.toHaveProperty("bot_name");
});

test("the name the first-run welcome saved is the name this page shows", async ({ page, request }) => {
  await request.post(`${GATEWAY_URL}/__control/firstRun`, { data: { state: "active", noMeetings: true } });
  await signIn(page, testEmail("tx-welcome"));
  const welcome = page.getByRole("dialog", { name: "Welcome to Vexa" });
  await welcome.getByLabel("Bot name").fill("Welcome Bot");
  await welcome.getByRole("button", { name: "Continue" }).click();
  await expect(welcome.getByRole("heading", { name: "Connect your calendar" })).toBeVisible();

  await page.goto("/settings/transcription");
  await expect(page.getByLabel("Name")).toHaveValue("Welcome Bot", { timeout: 20_000 });
});

test("an empty name is refused in words and writes nothing", async ({ page, request }) => {
  await signIn(page, testEmail("tx-name-empty"));
  await openSettings(page);
  await page.getByLabel("Name").fill("   ");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Give the bot a name")).toBeVisible();
  expect((await gatewayRequests(request)).some((r) => r.method === "PUT")).toBe(false);
});

test("setting your own endpoint, then switching back, clears the URL and the token together", async ({ page, request }) => {
  await signIn(page, testEmail("tx-backend"));
  await openSettings(page);

  await page.getByLabel("Your endpoint URL").fill("https://stt.example.test/v1");
  await page.getByLabel("Token").fill(SECRET);
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(page.getByText("Your meetings will be transcribed by your endpoint.")).toBeVisible();
  await expect(page.getByTestId("backend-current")).toContainText("(token saved)");
  await expect(page.getByLabel("Token")).toHaveValue("");

  await page.getByRole("button", { name: "Use this Vexa's service" }).click();
  await expect(page.getByText("Your meetings will be transcribed by this Vexa's service.")).toBeVisible();
  await expect(page.getByTestId("backend-current")).toHaveText("Using this Vexa's transcription service.");

  const writes = (await gatewayRequests(request)).filter((r) => r.method === "PUT" && r.url === "/user/transcription");
  expect(writes.map((r) => r.body)).toEqual([
    { url: "https://stt.example.test/v1", token: SECRET },
    { url: "", token: "" },
  ]);
  const read = await (await request.get(`${GATEWAY_URL}/user/transcription`, { headers: { "X-API-Key": "seed-key" } })).json();
  expect(read).toEqual({ url: null, token_set: false, token: null });
});

test("a token without an endpoint is refused before it is sent; the proxy refuses one too", async ({ page, request }) => {
  await signIn(page, testEmail("tx-token-only"));
  await openSettings(page);
  await page.getByLabel("Token").fill(SECRET);
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(page.getByText("a token is only used with your own endpoint")).toBeVisible();

  const res = await page.request.put("/api/vexa/user/transcription", { data: { token: SECRET } });
  expect(res.status()).toBe(400);
  expect((await gatewayRequests(request)).some((r) => r.url === "/user/transcription" && r.method === "PUT")).toBe(false);
});

test("a failed read is 'could not ask' with a retry, never a default", async ({ page, request }) => {
  await signIn(page, testEmail("tx-error"));
  await force(request, { userCalendarRead: 503 });
  await openSettings(page);

  const alert = page.getByRole("alert").filter({ hasText: "Couldn't load" });
  await expect(alert).toContainText("Couldn't load your transcription settings.");
  await expect(alert).toContainText("unreachable");
  await expect(page.getByLabel("Name")).toHaveCount(0);

  await force(request, { userCalendarRead: null, transcriptionRead: 500 });
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toContainText("Couldn't load your transcription settings.");
  await expect(alert).toContainText("request failed (500)");
  await expect(page.getByLabel("Name")).toHaveCount(0);

  await force(request, { transcriptionRead: null });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Vexa");
});
