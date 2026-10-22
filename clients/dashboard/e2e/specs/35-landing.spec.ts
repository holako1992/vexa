/** The public landing page at `/`.
 *
 *  Expected: a visitor with no session gets the landing page at `/` (not a redirect), with
 *  Features, Pricing and About sections and two doors into the app — "Log in" and "Try for free",
 *  both to /login. The pricing cards state the core's plan sheet (`GET /internal/billing/plans`):
 *  the catalog's limits and Stripe's prices; a paid plan with no price says "See pricing after
 *  sign-up"; a failed read says the plans couldn't load. The sheet is read on the server — the
 *  internal secret never reaches the browser. A signed-in person at `/` still gets their meetings,
 *  and every other page still sends a visitor to /login.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { GATEWAY_URL, INTERNAL_API_SECRET } from "../ports.mjs";
import { adminRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

async function forcePlanSheet(request: APIRequestContext, planSheet: string | null): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { planSheet } });
}

test("a visitor at / gets the landing page with its sections and both doors to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Every meeting, written down and ready to act on");
  for (const name of ["What it does", "How it works", "Pricing", "About Vexa"]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const [name, href] of [["Features", "#features"], ["Pricing", "#pricing"], ["About", "#about"]]) {
    await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
  }
  await expect(nav.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  await nav.getByRole("link", { name: "Try for free" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Vexa" })).toBeVisible();
  // …and the sign-in card's logo leads back.
  await page.getByRole("link", { name: "Vexa home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("pricing states the catalog's limits and Stripe's prices, read on the server", async ({ page, request }) => {
  await page.goto("/#pricing");
  const free = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Free", exact: true }) });
  await expect(free.getByTestId("price-free")).toHaveText("Free");
  await expect(free.getByText("1 meeting a month")).toBeVisible();
  await expect(free.getByText("Up to 60 minutes per meeting")).toBeVisible();
  await expect(free.getByText("Recordings kept for 7 days")).toBeVisible();
  await expect(free.getByRole("link", { name: "Try for free" })).toHaveAttribute("href", "/login");

  const pro = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Pro", exact: true }) });
  await expect(pro.getByTestId("price-pro")).toContainText("$12 / month");
  await expect(pro.getByTestId("price-pro")).toContainText("or $120 / year — save 17%");
  await expect(pro.getByText("Unlimited meetings")).toBeVisible();
  // A paid plan's door signs you in and lands on billing.
  await expect(pro.getByRole("link", { name: "Get Pro" })).toHaveAttribute("href", "/login?next=%2Fbilling");

  const team = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Team", exact: true }) });
  await expect(team.getByTestId("price-team")).toHaveText("$29 / month");
  await expect(team.getByText("5 bots in meetings at once")).toBeVisible();

  // The server read the sheet over the internal edge; the browser never saw the secret.
  const reads = (await adminRequests(request)).filter((r) => r.url.includes("/internal/billing/plans"));
  expect(reads.length).toBeGreaterThan(0);
  expect(await page.content()).not.toContain(INTERNAL_API_SECRET);
});

test("a paid plan with no configured price says so instead of inventing one", async ({ page, request }) => {
  await forcePlanSheet(request, "noPrices");
  await page.goto("/");
  await expect(page.getByTestId("price-pro")).toHaveText("See pricing after sign-up");
  await expect(page.getByTestId("price-team")).toHaveText("See pricing after sign-up");
  await expect(page.getByTestId("price-free")).toHaveText("Free");
});

test("a failed plan read is said, never a guessed price", async ({ page, request }) => {
  await forcePlanSheet(request, "fail");
  await page.goto("/");
  await expect(page.locator("#pricing").getByRole("status")).toContainText("The plans couldn't be loaded just now");
  await expect(page.locator("[data-testid^=price-]")).toHaveCount(0);
});

test("a signed-in person at / gets their meetings, not the landing page", async ({ page }) => {
  await signIn(page, testEmail("landing-signed-in"));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Every meeting, written down and ready to act on" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Meetings" })).toBeVisible();
});

test("the landing page has no horizontal scroll at 375x812", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
