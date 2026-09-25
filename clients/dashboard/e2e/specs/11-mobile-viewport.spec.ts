/** Property 11 — the shell is usable at 375px (DB-04's stated floor), not just responsive down to
 *  tablet width.
 *
 *  Expected: at 375×812, the meetings list and a meeting's detail page both render with no
 *  horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`), and the rail —
 *  hidden by default at this width — opens as a drawer from the menu button and can be closed
 *  again, without ever causing the page itself to scroll sideways.
 */
import { test, expect } from "@playwright/test";
import { resetStub, signIn, testEmail } from "./helpers";

test.use({ viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ request }) => { await resetStub(request); });

async function noHorizontalOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

test("the meetings list has no horizontal scroll at 375×812", async ({ page }) => {
  await signIn(page, testEmail("mobile-list"));
  await page.getByRole("heading", { name: "Design Review" }).waitFor();

  expect(await noHorizontalOverflow(page)).toBe(true);

  // The rail is a drawer at this width: translated off-canvas rather than unmounted when closed,
  // so its actual on-screen presence is asserted with `toBeInViewport()` — a plain `toBeVisible()`
  // would pass even while it sits off-screen, since a CSS transform doesn't zero out the
  // bounding box Playwright's own visibility check looks at.
  const navLink = page.getByRole("link", { name: "Meetings" });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(navLink).not.toBeInViewport();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(navLink).toBeInViewport();
  expect(await noHorizontalOverflow(page)).toBe(true);

  await page.getByRole("button", { name: "Close navigation" }).first().click();
  await expect(navLink).not.toBeInViewport();
});

test("a meeting's detail page has no horizontal scroll at 375×812", async ({ page }) => {
  await signIn(page, testEmail("mobile-detail"));
  await page.getByRole("heading", { name: "Design Review" }).waitFor();

  await page.getByRole("heading", { name: "Design Review" }).click();
  await expect(page).toHaveURL(/\/meetings\/102$/);
  await expect(page.getByText("Let's start with the new onboarding flow.")).toBeVisible();

  expect(await noHorizontalOverflow(page)).toBe(true);
});
