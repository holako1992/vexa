/** DB-44 — global search: `Ctrl+K` reaches the shell's search box from any page, results land on
 *  `/search` grouped by meeting with the matched text highlighted, and a hit links to its meeting
 *  with `?t=<start>` so `MeetingDetail` can scroll to and highlight the matching segment.
 *
 *  The stub's fixture (`../fixtures.mjs`) has two meetings whose transcripts both contain
 *  "calendar" — 102 ("Design Review") and 105 ("Support Retro") — which is what proves grouping
 *  actually groups by meeting rather than flattening every hit into one list.
 */
import { test, expect } from "@playwright/test";
import { forceSearch, gatewayRequests, holdSearch, releaseSearch, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("Ctrl+K focuses the shell search box from the meetings list, Enter navigates to /search", async ({ page }) => {
  await signIn(page, testEmail("search-kbd"));

  await page.keyboard.press("Control+k");
  const box = page.getByLabel("Search meetings and transcripts");
  await expect(box).toBeFocused();

  await box.fill("calendar");
  await box.press("Enter");

  await page.waitForURL("**/search?q=calendar");
  await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
});

test("results are grouped by meeting, snippets highlight the matched term, and each hit links with ?t=", async ({
  page,
}) => {
  await signIn(page, testEmail("search-results"));
  await page.goto("/search?q=calendar");

  const designReviewGroup = page.getByRole("heading", { name: /Design Review|Zoom · 1234567890/ });
  // The group heading text is "<Platform Label> · <native id>" (search hits don't carry a title,
  // only platform/native/meeting_db_id) — meeting 102 is Zoom · 1234567890.
  await expect(page.getByText("Zoom · 1234567890")).toBeVisible();
  await expect(page.getByText("Zoom · 5550001111")).toBeVisible(); // meeting 105

  // The matched word is wrapped in a <mark>, not just present as plain text somewhere on the page.
  const marks = page.locator("mark", { hasText: /calendar/i });
  await expect(marks.first()).toBeVisible();
  expect(await marks.count()).toBeGreaterThanOrEqual(2); // at least one per meeting group

  const hitLink = page.getByRole("link", { name: /calendar connection screen/i });
  await expect(hitLink).toHaveAttribute("href", /\/meetings\/102\?t=34/);
  void designReviewGroup;
});

test("clicking a hit scrolls to and highlights the matching segment on the meeting page", async ({ page }) => {
  await signIn(page, testEmail("search-scroll"));
  await page.goto("/search?q=calendar");

  await page.getByRole("link", { name: /calendar connection screen/i }).click();
  await page.waitForURL(/\/meetings\/102\?t=34/);

  const segment = page.locator("li", { hasText: "calendar connection screen" });
  await expect(segment).toBeVisible();
  // The highlighted segment carries the accent ring class — proof the RIGHT line was picked, not
  // just that the page loaded.
  await expect(segment).toHaveClass(/ring-accent/);
});

test("no matches renders the empty state, not a blank page or 'no meetings'", async ({ page }) => {
  await signIn(page, testEmail("search-empty"));
  await page.goto("/search?q=zzz-nothing-matches-zzz");

  await expect(page.getByText(/No matches for/)).toBeVisible();
  await expect(page.locator("mark")).toHaveCount(0);
});

test("a forced failure renders the error state with retry, not an empty result", async ({ page, request }) => {
  await signIn(page, testEmail("search-error"));
  await forceSearch(request, 500);
  await page.goto("/search?q=calendar");

  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.getByText(/No matches for/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the loading state is shown while the search request is in flight", async ({ page, request }) => {
  await signIn(page, testEmail("search-loading"));
  await holdSearch(request);
  await page.goto("/search?q=calendar");
  await expect(page.getByText(/Searching for/)).toBeVisible();
  await releaseSearch(request);
  await expect(page.getByText(/Searching for/)).toHaveCount(0);
  await expect(page.locator("mark").first()).toBeVisible();
});

test("q never reaches GET /meetings, and reaches /transcripts/search intact", async ({ page, request }) => {
  await signIn(page, testEmail("search-q-isolation"));
  await page.goto("/search?q=calendar");
  await expect(page.locator("mark").first()).toBeVisible();

  const log = await gatewayRequests(request);
  const meetingsCalls = log.filter((r) => r.method === "GET" && r.url.startsWith("/meetings"));
  for (const call of meetingsCalls) {
    expect(call.url).not.toContain("q=");
  }
  const searchCalls = log.filter((r) => r.method === "GET" && r.url.startsWith("/transcripts/search"));
  expect(searchCalls.some((c) => c.url.includes("q=calendar"))).toBe(true);
});
