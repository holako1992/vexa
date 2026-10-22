/** Empty and error states across the dashboard: "you have none" names the next action, "could not
 *  ask" looks different from it and offers a retry, and a mutation answers with a toast.
 *
 *  Expected:
 *   - An account with no meetings sees "No meetings yet." with a "Send a bot" action that opens
 *     the Add Bot dialog; the empty Upcoming tab offers "Connect a calendar", which opens the same
 *     dialog on its Calendar tab.
 *   - A failed "Load more" keeps the loaded rows on screen and reports the failure in a toast.
 *   - A failed participants read on a meeting says so, with a retry that then shows the roster.
 *   - An empty recordings list links back to the meetings; the empty Upcoming page links to
 *     /calendar, and its "Sync now" with an unreadable roster says it could not read it, never
 *     "No calendars connected".
 *   - A failed plan read on /billing shows the error with "Try again", which then shows the plan.
 *   - Adding a tag confirms with a toast.
 *
 *  Failures and most empty answers are injected at the browser's own `/api/vexa/*` requests with
 *  `page.route`; the empty account is the stub's own `/__control/firstRun {noMeetings}` world,
 *  past its welcome (`state: "done"`), so the list itself answers.
 */
import { test, expect, type Page } from "@playwright/test";
import { resetStub, signIn, testEmail } from "./helpers";
import { GATEWAY_URL } from "../ports.mjs";

test.beforeEach(async ({ request }) => { await resetStub(request); });

function answer(page: Page, path: string, status: number, body: unknown, when?: (url: URL) => boolean) {
  return page.route(
    (url) => url.pathname === path && (!when || when(url)),
    (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

test("no meetings: the empty list names the next action for each tab", async ({ page, request }) => {
  // An account past its welcome, with no meetings: the list itself is what answers.
  await request.post(`${GATEWAY_URL}/__control/firstRun`, { data: { state: "done", noMeetings: true } });
  await signIn(page, testEmail("empty-list"));

  await expect(page.getByText("No meetings yet.")).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Send a bot" }).click();
  await expect(page.getByRole("dialog", { name: "Add a Vexa Bot" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Upcoming" }).click();
  await expect(page.getByText("Nothing scheduled.")).toBeVisible();
  await page.getByRole("button", { name: "Connect a calendar" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await expect(dialog.getByTestId("calendar-connect-panel")).toBeVisible();
});

test("a failed Load more keeps the loaded rows and says so in a toast", async ({ page }) => {
  await signIn(page, testEmail("load-more-fail"));
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();
  await answer(page, "/api/vexa/meetings", 503, { detail: "down" }, (url) => url.searchParams.get("offset") !== "0");

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Couldn't load more meetings")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("participants: could-not-ask shows a retry, and the retry shows the roster", async ({ page }) => {
  await signIn(page, testEmail("participants-fail"));
  const path = "/api/vexa/meetings/google_meet/abc-defg-hij/participants";
  await answer(page, path, 503, { detail: "down" });
  await page.goto("/meetings/101");

  const alert = page.locator("main").getByRole("alert").filter({ hasText: "Couldn't load participants" });
  await expect(alert).toBeVisible();
  await page.unrouteAll();
  await alert.getByRole("button", { name: "Retry loading participants" }).click();
  await expect(page.getByText("Participants", { exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("no recordings links back to the meetings", async ({ page }) => {
  await signIn(page, testEmail("empty-recordings"));
  await answer(page, "/api/vexa/recordings", 200, { recordings: [], has_more: false, total: 0 });
  await page.goto("/recordings");

  await expect(page.getByText("No recordings yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to your meetings" })).toHaveAttribute("href", "/");
});

test("Upcoming: empty links to /calendar; Sync now with an unreadable roster says so", async ({ page }) => {
  await signIn(page, testEmail("upcoming-empty"));
  await answer(page, "/api/vexa/meetings", 200, { meetings: [], has_more: false });
  await answer(page, "/api/vexa/user/calendars", 503, { detail: "down" });
  await page.goto("/upcoming");

  await expect(page.getByText("No upcoming meetings")).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: "Connect a calendar" })).toHaveAttribute("href", "/calendar");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Couldn't read your calendars")).toBeVisible();
  await expect(page.getByText("No calendars connected")).toHaveCount(0);
});

test("billing: a failed plan read retries into the plan", async ({ page }) => {
  await signIn(page, testEmail("billing-fail"));
  await answer(page, "/api/vexa/user/entitlements", 503, { detail: "down" });
  await page.goto("/billing");

  const main = page.locator("main");
  await expect(main.getByRole("alert")).toBeVisible();
  await page.unrouteAll();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Free plan" })).toBeVisible();
});

test("adding a tag confirms with a toast", async ({ page }) => {
  await signIn(page, testEmail("tag-toast"));
  await page.goto("/meetings/102");
  const tags = page.getByRole("group", { name: "Tags" });
  await tags.getByRole("button", { name: "Add tag" }).click();
  await tags.getByRole("textbox", { name: "New tag" }).fill("roadmap");
  await tags.getByRole("textbox", { name: "New tag" }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Tagged “roadmap”." })).toBeVisible();
});
