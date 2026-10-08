/** Property 30 — the first-run welcome: three steps for a new account with no meetings.
 *
 *  Expected:
 *   - a NEW account with no meetings sees the welcome after signing in; an account with meetings
 *     does not; an account that is not new does not, however empty its list; and an ended welcome
 *     (done or skipped) never comes back.
 *   - the bot's name is saved as the person's default (`PUT /user/calendar {bot_name}`), and the
 *     form that sends a bot says that name afterwards.
 *   - where the person is survives a refresh: it resumes at the step the producer holds.
 *   - Skip setup works from every step, is saved, and the welcome never shows again; closing the
 *     dialog only hides it for this visit, with a way back.
 *   - the calendar round trip (consent screen → callback → home) resumes the welcome at the last
 *     step instead of opening the Add Bot dialog.
 *   - a fresh account reaches its first meeting page in three clicks from landing signed in:
 *     the third step, Send Bot, Open meeting.
 *   - a spent or unverified allowance is said up front and in plain words on a refusal, with
 *     connecting a calendar still on offer — never a dead end.
 *   - at 375px nothing scrolls sideways, and the steps are reachable from the keyboard.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { DASHBOARD_URL, GATEWAY_URL } from "../ports.mjs";
import { E2E_GOOGLE_EMAIL, freeEntitlements, identityUnverifiedEntitlements } from "../fixtures.mjs";
import {
  dispatchedBots,
  forceBotsQuotaExceeded,
  gatewayRequests,
  resetStub,
  setEntitlements,
  signIn,
  testEmail,
} from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

/** The account the next sign-in lands on, as the producer would hold it. */
async function world(
  request: APIRequestContext,
  w: { state?: string; step?: string; noMeetings?: boolean; dispatchCreatesMeeting?: boolean },
): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/firstRun`, { data: w });
  if (!res.ok()) throw new Error(`stub first-run world failed: ${res.status()}`);
}

/** A brand-new account: unfinished welcome, empty list. */
const newAccount = (request: APIRequestContext, extra: { step?: string; dispatchCreatesMeeting?: boolean } = {}) =>
  world(request, { state: "active", noMeetings: true, ...extra });

const welcome = (page: Page) => page.getByRole("dialog", { name: "Welcome to Vexa" });

async function firstRunWrites(request: APIRequestContext): Promise<unknown[]> {
  return (await gatewayRequests(request))
    .filter((r) => r.method === "PUT" && r.url === "/user/first-run")
    .map((r) => r.body);
}

async function interceptGoogleConsent(page: Page) {
  await page.route("https://accounts.google.com/**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state") ?? "";
    const query = new URLSearchParams({ code: "e2e-test-code", state }).toString();
    await route.fulfill({ status: 302, headers: { location: `${DASHBOARD_URL}/calendar/google/callback?${query}` } });
  });
}

// ── who sees it ──────────────────────────────────────────────────────────────────────────────

test("a new account with no meetings is welcomed, with a visible step indicator", async ({ page, request }) => {
  await newAccount(request);
  await signIn(page, testEmail("fr-new"));

  await expect(welcome(page)).toBeVisible();
  const steps = page.getByRole("list", { name: "Setup steps" });
  await expect(steps.getByRole("button")).toHaveCount(3);
  await expect(steps.getByRole("button", { name: /Step 1: Bot name/ })).toHaveAttribute("aria-current", "step");
  await expect(page.getByLabel("Bot name")).toHaveValue("Vexa");
  await expect(page.getByRole("button", { name: "Skip setup" })).toBeVisible();
});

test("an account with meetings is not welcomed", async ({ page }) => {
  // The fixture world is a new account (unfinished welcome) that already has meetings.
  await signIn(page, testEmail("fr-has-meetings"));
  await page.getByRole("heading", { name: "Design Review" }).waitFor();
  await expect(welcome(page)).toHaveCount(0);
});

test("an account that is not new is not welcomed, however empty its list", async ({ page, request }) => {
  await world(request, { state: "none", noMeetings: true });
  await signIn(page, testEmail("fr-not-new"));
  await expect(page.getByText("No meetings yet.")).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

for (const ended of ["done", "skipped"]) {
  test(`an ended welcome (${ended}) never comes back`, async ({ page, request }) => {
    await world(request, { state: ended, noMeetings: true });
    await signIn(page, testEmail(`fr-${ended}`));
    await expect(page.getByText("No meetings yet.")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Finish setup" })).toHaveCount(0);
  });
}

test("a welcome whose state cannot be read is not shown", async ({ page, request }) => {
  await world(request, { state: "garbled", noMeetings: true });
  await signIn(page, testEmail("fr-garbled"));
  await expect(page.getByText("No meetings yet.")).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

// ── the bot's name ───────────────────────────────────────────────────────────────────────────

test("the bot name is saved as the default, the step is saved, and a refresh resumes", async ({ page, request }) => {
  await newAccount(request);
  await signIn(page, testEmail("fr-name"));

  await page.getByLabel("Bot name").fill("  Scribe  ");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Connect your calendar" })).toBeVisible();

  const reqs = await gatewayRequests(request);
  const nameWrite = reqs.find((r) => r.method === "PUT" && r.url === "/user/calendar");
  expect(nameWrite?.body).toEqual({ bot_name: "Scribe" }); // trimmed, and only that key
  expect(await firstRunWrites(request)).toEqual([{ step: "calendar" }]);

  await page.reload();
  await expect(welcome(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your calendar" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Step 2: Calendar/ })).toHaveAttribute("aria-current", "step");

  // Back to the first step: the saved name is what the field shows now.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Bot name")).toHaveValue("Scribe");
});

test("an unchanged name writes nothing; an empty or over-long one is refused in words", async ({ page, request }) => {
  await newAccount(request);
  await signIn(page, testEmail("fr-name-invalid"));

  await page.getByLabel("Bot name").fill("   ");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Give the bot a name")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Name your notetaker" })).toBeVisible();

  await page.getByLabel("Bot name").fill("Vexa"); // what it already is
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Connect your calendar" })).toBeVisible();

  const reqs = await gatewayRequests(request);
  expect(reqs.some((r) => r.method === "PUT" && r.url === "/user/calendar")).toBe(false);
});

test("the form that sends a bot says the name the person chose", async ({ page, request }) => {
  await newAccount(request);
  await signIn(page, testEmail("fr-name-shown"));

  await page.getByLabel("Bot name").fill("Scribe");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Step 3: First meeting/ }).click();
  await expect(page.getByText(/appears in the meeting as "Scribe"/)).toBeVisible();
});

// ── progress and skipping ────────────────────────────────────────────────────────────────────

test("a refresh resumes the last step", async ({ page, request }) => {
  await newAccount(request, { step: "meeting" });
  await signIn(page, testEmail("fr-resume"));

  await expect(page.getByRole("heading", { name: "Send your bot to a meeting" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Send your bot to a meeting" })).toBeVisible();
});

for (const step of ["name", "calendar", "meeting"]) {
  test(`Skip setup works from the ${step} step, is saved, and never shows again`, async ({ page, request }) => {
    await newAccount(request, { step });
    await signIn(page, testEmail(`fr-skip-${step}`));

    await expect(welcome(page)).toBeVisible();
    await page.getByRole("button", { name: "Skip setup" }).click();
    await expect(welcome(page)).toHaveCount(0);
    await expect(page.getByText("No meetings yet.")).toBeVisible();
    expect(await firstRunWrites(request)).toEqual([{ state: "skipped" }]);

    await page.reload();
    await expect(page.getByText("No meetings yet.")).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);

    // The ordinary way in is still there.
    await page.getByRole("button", { name: "Add Bot" }).click();
    await expect(page.getByRole("dialog", { name: "Add a Vexa Bot" })).toBeVisible();
  });
}

test("closing the dialog only hides it for this visit, and offers a way back", async ({ page, request }) => {
  await newAccount(request);
  await signIn(page, testEmail("fr-close"));

  await expect(welcome(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(welcome(page)).toHaveCount(0);
  expect(await firstRunWrites(request)).toEqual([]); // not a decision, so nothing is saved

  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(welcome(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(welcome(page)).toBeVisible(); // still unfinished at the producer
});

// ── the calendar round trip ──────────────────────────────────────────────────────────────────

test("connecting a calendar leaves the app, comes back, and resumes the welcome", async ({ page, request }) => {
  await newAccount(request, { step: "calendar" });
  await signIn(page, testEmail("fr-calendar"));
  await interceptGoogleConsent(page);

  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Google Calendar connected" })).toBeVisible();
  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");

  // Back inside the welcome, on its last step — not the Add Bot dialog.
  await expect(welcome(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Add a Vexa Bot" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Send your bot to a meeting" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Google Calendar connected." })).toBeVisible();
  await expect(page).toHaveURL(/\/$/); // the return parameters are gone

  // The position was written, so a refresh keeps it; and the calendar is shown as connected.
  expect(await firstRunWrites(request)).toContainEqual({ step: "meeting" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Send your bot to a meeting" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText(`Connected: ${E2E_GOOGLE_EMAIL}`)).toBeVisible();
});

test("a declined consent screen returns to the calendar step, with a way on", async ({ page, request }) => {
  await newAccount(request, { step: "calendar" });
  await signIn(page, testEmail("fr-calendar-declined"));
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 302, headers: { location: `${DASHBOARD_URL}/calendar/google/callback?error=access_denied` } }));

  await page.getByRole("button", { name: "Connect Google Calendar" }).click();
  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Couldn't connect Google Calendar" })).toBeVisible();
  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");

  await expect(welcome(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your calendar" })).toBeVisible();
  await expect(page.getByText("The calendar wasn't connected")).toBeVisible();
  await page.getByRole("button", { name: "Continue without a calendar" }).click();
  await expect(page.getByRole("heading", { name: "Send your bot to a meeting" })).toBeVisible();
});

// ── a first transcript in three clicks ───────────────────────────────────────────────────────

test("a fresh account reaches its first meeting page in three clicks", async ({ page, request }) => {
  await newAccount(request, { dispatchCreatesMeeting: true });
  await signIn(page, testEmail("fr-three-clicks"));
  await expect(welcome(page)).toBeVisible();

  // click 1 — straight to the last step
  await page.getByRole("button", { name: /Step 3: First meeting/ }).click();
  await page.getByLabel("Meeting URL").fill("https://meet.google.com/abc-defg-xyz");
  // click 2 — send the bot
  await page.getByRole("button", { name: "Send Bot" }).click();
  await expect(page.getByRole("heading", { name: "Your bot is joining" })).toBeVisible();
  // click 3 — open it
  await page.getByRole("link", { name: "Open meeting" }).click();

  await expect(page).toHaveURL(/\/meetings\/901$/);
  await expect(page.getByRole("heading", { name: "Meetings" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Google Meet · abc-defg-xyz" })).toBeVisible();

  const bots = await dispatchedBots(request);
  expect(bots).toHaveLength(1);
  expect(bots[0]).toMatchObject({ platform: "google_meet", native_meeting_id: "abc-defg-xyz" });
  expect(bots[0]).not.toHaveProperty("bot_name"); // the person's default is the producer's to apply

  // Sending the first bot ended the welcome: it is saved, and it does not come back.
  expect(await firstRunWrites(request)).toEqual([{ step: "meeting" }, { state: "done" }]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

// ── the allowance ────────────────────────────────────────────────────────────────────────────

test("the allowance is stated before anything is pasted", async ({ page, request }) => {
  await newAccount(request, { step: "meeting" });
  await setEntitlements(request, freeEntitlements({ used: 0 }));
  await signIn(page, testEmail("fr-allowance"));

  await expect(page.getByTestId("allowance-line")).toHaveText(/1 of 1 free meetings left this month/);
  await expect(page.getByLabel("Meeting URL")).toHaveValue("");
});

test("a spent allowance is a sentence with a way forward, not a dead end", async ({ page, request }) => {
  await newAccount(request, { step: "meeting" });
  await setEntitlements(request, freeEntitlements({ used: 1 }));
  await forceBotsQuotaExceeded(request);
  await signIn(page, testEmail("fr-spent"));

  await expect(page.getByTestId("allowance-line")).toHaveText(/0 of 1 free meetings left this month/);
  // The calendar stays on offer before anything is sent...
  await expect(page.getByRole("button", { name: "Connect a calendar instead" })).toBeVisible();

  await page.getByLabel("Meeting URL").fill("https://meet.google.com/abc-defg-xyz");
  await page.getByRole("button", { name: "Send Bot" }).click();
  const notice = page.getByRole("status").filter({ hasText: "You've used your 1 meeting for this billing period." });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: "See billing" })).toHaveAttribute("href", "/billing");
  await expect(page.getByRole("dialog", { name: "Welcome to Vexa" }).getByText("Payment required")).toHaveCount(0);

  // ...and takes the person to the calendar step.
  await page.getByRole("button", { name: "Connect a calendar instead" }).click();
  await expect(page.getByRole("heading", { name: "Connect your calendar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  expect(await firstRunWrites(request)).toContainEqual({ step: "calendar" });
});

test("an unverified account is told why, up front and on a refusal, and can still connect a calendar", async ({ page, request }) => {
  await newAccount(request, { step: "meeting" });
  await setEntitlements(request, identityUnverifiedEntitlements());
  await forceBotsQuotaExceeded(request, "identity_unverified");
  await signIn(page, testEmail("fr-unverified"));

  const why = /Your email address isn't verified, so the free meeting isn't available\. Sign in with Google or Microsoft to verify it, or upgrade your plan\./;
  await expect(page.getByTestId("allowance-line")).toHaveText(why);
  await expect(page.getByRole("button", { name: "Connect a calendar instead" })).toBeVisible();

  await page.getByLabel("Meeting URL").fill("https://meet.google.com/abc-defg-xyz");
  await page.getByRole("button", { name: "Send Bot" }).click();
  await expect(page.getByRole("status").filter({ hasText: why })).toBeVisible();
  expect(await dispatchedBots(request)).toHaveLength(0);

  await page.getByRole("button", { name: "Connect a calendar instead" }).click();
  await expect(page.getByRole("button", { name: "Connect Microsoft 365" })).toBeVisible();
  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(welcome(page)).toHaveCount(0);
});

// ── keyboard and small screens ───────────────────────────────────────────────────────────────

test("the whole welcome is operable from the keyboard", async ({ page, request }) => {
  await newAccount(request);
  await signIn(page, testEmail("fr-keyboard"));

  // The name field has focus; Enter submits the step.
  await expect(page.getByLabel("Bot name")).toBeFocused();
  await page.getByLabel("Bot name").fill("Keyboard Bot");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Connect your calendar" })).toBeVisible();

  // The step buttons are real buttons in the tab order.
  await page.getByRole("button", { name: /Step 3: First meeting/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Send your bot to a meeting" })).toBeVisible();

  // Focus stays inside the dialog.
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
});

test.describe("at 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("every step fits without scrolling sideways and keeps Skip reachable", async ({ page, request }) => {
    await newAccount(request);
    await signIn(page, testEmail("fr-mobile"));
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    for (const label of [/Step 1/, /Step 2/, /Step 3/]) {
      await page.getByRole("button", { name: label }).click();
      await expect(page.getByRole("button", { name: "Skip setup" })).toBeInViewport();
      expect(await fits()).toBe(true);
      const dialog = await welcome(page).boundingBox();
      expect(dialog!.x).toBeGreaterThanOrEqual(0);
      expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(375);
    }
  });
});
