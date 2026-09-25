/** DB-48 — pagination against the stub's now-25-row `/meetings` fixture (6 named rows + 19
 *  "Archived Call N" rows, `../fixtures.mjs`).
 *
 *  Expected:
 *   1. The list loads the first page (20 rows) and shows "Load more"; clicking it appends the
 *      remaining 5 and the button disappears (`pageMayContinue` reading a short page as "no more").
 *   2. A meeting that only becomes live AFTER it was loaded via "Load more" (so it sits beyond the
 *      first page) is still shown live once the phase-aware poll re-fetches — proving the poll's
 *      "re-fetch the whole loaded window, not just page one" rule from `MeetingsView.tsx`'s header
 *      comment, not just the unit-level `mergeMeetingsPage` behaviour. This relies on real time,
 *      not a mocked clock: the fixture's "Weekly Sync" (id 101) is already live and always on page
 *      one, so the poll is already on its 5s ("something is live") cadence from the first load —
 *      no 30-second idle wait to short-circuit.
 *   3. No per-tab numeric badge is rendered; one "N loaded" line is, and it updates after Load
 *      more.
 */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, setMeetingStatus, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("Load more appends the remaining page and then hides itself", async ({ page }) => {
  await signIn(page, testEmail("pag-load-more"));

  await expect(page.getByText(/^20 loaded/)).toBeVisible();
  await expect(page.getByText("more available")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Archived Call 19" })).toHaveCount(0);

  await page.getByRole("button", { name: "Load more" }).click();

  await expect(page.getByRole("heading", { name: "Archived Call 19" })).toBeVisible();
  await expect(page.getByText(/^25 loaded/)).toBeVisible();
  await expect(page.getByText("more available")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("Load more is reachable and activated by the keyboard alone", async ({ page }) => {
  await signIn(page, testEmail("pag-load-more-kbd"));
  await expect(page.getByText(/^20 loaded/)).toBeVisible();

  const button = page.getByRole("button", { name: "Load more" });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Archived Call 19" })).toBeVisible();
});

test("no per-tab numeric badge is rendered — only the one honest 'N loaded' line", async ({ page }) => {
  await signIn(page, testEmail("pag-counts"));
  await expect(page.getByText(/^20 loaded/)).toBeVisible();

  const liveTab = page.getByRole("tab", { name: /^Live/ });
  // The tab's accessible name is exactly "Live" — no trailing count digit glued onto it.
  await expect(liveTab).toHaveAccessibleName("Live");
});

test("a live row loaded via Load more stays visible once the poll re-fetches the full window", async ({
  page,
  request,
}) => {
  await signIn(page, testEmail("pag-live-later-page"));
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("heading", { name: "Archived Call 19" })).toBeVisible();

  // Archived Call 19 is row id 218 (200 + 18) — see fixtures.mjs's ARCHIVED_ROWS.
  await setMeetingStatus(request, 218, "active");

  // "Weekly Sync" (id 101) is live and always on page one, so the poll has been on its 5s
  // ("something is live") cadence since the very first load — the next tick lands well inside
  // this assertion's retry window.
  const row = page.locator("li", { hasText: "Archived Call 19" });
  await expect(row.getByText("active")).toBeVisible({ timeout: 8_000 });
  await expect(row.locator(".live-dot")).toBeVisible();
});

test("the poll's own GET /meetings carries limit = the number of rows currently loaded", async ({ page, request }) => {
  await signIn(page, testEmail("pag-poll-window"));
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(/^25 loaded/)).toBeVisible();

  await expect(async () => {
    const log = await gatewayRequests(request);
    const pollRequest = [...log].reverse().find((r) => r.method === "GET" && r.url.startsWith("/meetings?"));
    expect(pollRequest?.url).toContain("limit=25");
    expect(pollRequest?.url).toContain("offset=0");
  }).toPass({ timeout: 8_000 });
});

test("'Load more' does not resurface once the loaded count happens to equal the true total", async ({ page }) => {
  // Caught live (not by any unit test): once every row is loaded, the poll's own window-refresh
  // re-fetch asks for exactly `limit=<rows loaded>` — which, when that number equals the actual
  // total, comes back as a FULL page. Judging that by the same "full page ⇒ maybe more" rule
  // `pageMayContinue` uses for a real next-page probe made "Load more" reappear forever after the
  // very first poll tick past loading everything. `MeetingsView.tsx`'s `load()` now only applies
  // that rule on the initial fetch; a poll only ever flips `hasMore` to `false` (a window that
  // came back SHORTER than asked), never back to `true`.
  await signIn(page, testEmail("pag-no-phantom-more"));
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(/^25 loaded/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // Give the live-cadence poll (Weekly Sync, id 101, is live and always on page one) more than
  // one full tick to run its window re-fetch, then confirm the button is STILL gone.
  await page.waitForTimeout(6_500);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(page.getByText("more available")).toHaveCount(0);
});
