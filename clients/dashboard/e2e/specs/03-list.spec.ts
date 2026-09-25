/** Property 3 — the meetings list renders the fixture rows, the phase tabs filter, and search
 *  narrows.
 *
 *  Expected: all four fixture meetings render; clicking "Live" shows only the live one; typing
 *  "Design" narrows to the one meeting whose title matches.
 */
import { test, expect } from "@playwright/test";
import { resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("renders the fixture meetings, tabs filter by phase, search narrows", async ({ page }) => {
  await signIn(page, testEmail("list"));

  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Roadmap Planning" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Daily Standup" })).toBeVisible();

  await page.getByRole("tab", { name: /Live/ }).click();
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Design Review" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Roadmap Planning" })).toHaveCount(0);

  await page.getByRole("tab", { name: /^All/ }).click();
  // DB-48 renamed the local filter box: it only ever narrows what is already loaded, distinct
  // from the global search box in the shell (DB-44) — see MeetingsView.tsx's header comment.
  await page.getByLabel("Filter loaded meetings").fill("Design");
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Roadmap Planning" })).toHaveCount(0);
});
