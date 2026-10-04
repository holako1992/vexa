/** The billing page's purchase controls: Upgrade (`POST /billing/checkout {plan, interval}` →
 *  redirect) and, for a subscriber, the "Payment method & invoices" link (`POST /billing/portal`
 *  → redirect). Cancel and resume are in `18-billing-switch-plan.spec.ts`.
 *
 *  Expected:
 *   - Clicking Upgrade on a plan card sends the exact `{plan, interval}` the card and the
 *     monthly/yearly toggle say, and the browser navigates to the URL the stub returns. The stub
 *     encodes the body it received into the returned Checkout URL's fragment (`#<plan>_<interval>`,
 *     see `stub-server.mjs`) specifically so a spec can prove the BODY reached the stub, not just
 *     that some request did — the stub's own request log only keeps method/url/headers.
 *   - Real navigation to `checkout.stripe.com`/`billing.stripe.com` never happens: each test
 *     installs a `page.route()` intercept for exactly that host before clicking, so the browser's
 *     navigation is fulfilled locally rather than leaving the test environment.
 *   - A subscriber's "Payment method & invoices" redirects to the Stripe portal URL; an account
 *     with no subscription sees neither that link nor a cancel button.
 */
import { test, expect } from "@playwright/test";
import { proMonthlySubscriberEntitlements } from "../fixtures.mjs";
import { resetStub, setEntitlements, setStripeCustomer, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("upgrade: Pro + Monthly sends {plan: 'pro', interval: 'month'} and navigates to Checkout", async ({ page, request }) => {
  await signIn(page, testEmail("billing-upgrade-pro-month"));
  await page.goto("/billing");

  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html>stripe checkout (e2e stub)</html>" }),
  );

  const proCard = page.getByRole("heading", { name: "Pro" }).locator("..");
  await proCard.getByRole("button", { name: "Upgrade" }).click();

  // The fragment (`#pro_month`) never reaches the server — a route's own `request().url()` would
  // not carry it — so the proof reads the BROWSER's address bar via `page.url()`, which does.
  await page.waitForURL(/checkout\.stripe\.com\/.*#pro_month/);
});

test("upgrade: Team + Yearly (toggled) sends {plan: 'team', interval: 'year'}", async ({ page, request }) => {
  await signIn(page, testEmail("billing-upgrade-team-year"));
  await page.goto("/billing");

  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html>stripe checkout (e2e stub)</html>" }),
  );

  await page.getByRole("tab", { name: "Yearly" }).click();
  const teamCard = page.getByRole("heading", { name: "Team" }).locator("..");
  await teamCard.getByRole("button", { name: "Upgrade" }).click();

  await page.waitForURL(/checkout\.stripe\.com\/.*#team_year/);
});

test("no subscription: neither the portal link nor a cancel button is shown", async ({ page }) => {
  await signIn(page, testEmail("billing-no-subscription"));
  await page.goto("/billing");

  await expect(page.getByRole("button", { name: "Upgrade" }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "Payment method & invoices" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
});

test("payment method & invoices: a subscriber goes straight to the Stripe portal", async ({ page, request }) => {
  await setStripeCustomer(request, true);
  await setEntitlements(request, proMonthlySubscriberEntitlements());
  await signIn(page, testEmail("billing-manage-success"));
  await page.goto("/billing");

  let navigatedTo: string | null = null;
  await page.route("https://billing.stripe.com/**", async (route) => {
    navigatedTo = route.request().url();
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>stripe portal (e2e stub)</html>" });
  });

  await page.getByRole("button", { name: "Payment method & invoices" }).click();

  await page.waitForURL(/billing\.stripe\.com/);
  expect(navigatedTo).toContain("/p/session/");
});

test("upgrade: the button disables while the checkout request is in flight", async ({ page, request }) => {
  await signIn(page, testEmail("billing-upgrade-pending"));
  await page.goto("/billing");

  // Delay the stub's answer so the disabled/loading state is actually observable rather than
  // racing an instant local response.
  await page.route("**/api/vexa/billing/checkout", async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html>stripe checkout (e2e stub)</html>" }),
  );

  const proCard = page.getByRole("heading", { name: "Pro" }).locator("..");
  const upgradeButton = proCard.getByRole("button", { name: "Upgrade" });
  await upgradeButton.click();
  await expect(upgradeButton).toBeDisabled();

  const teamCard = page.getByRole("heading", { name: "Team" }).locator("..");
  await expect(teamCard.getByRole("button", { name: "Upgrade" })).toBeDisabled();
});

test("prices: each card shows Stripe's price, and Yearly adds the saving over monthly", async ({ page }) => {
  await signIn(page, testEmail("billing-prices"));
  await page.goto("/billing");

  await expect(page.getByTestId("price-pro")).toHaveText("$5 / month");
  await expect(page.getByTestId("price-team")).toHaveText("$20 / month");

  await page.getByRole("tab", { name: "Yearly" }).click();
  await expect(page.getByTestId("price-pro")).toHaveText("$50 / year · save 17%");
  await expect(page.getByTestId("price-team")).toHaveText("$100 / year · save 58%");
});

test("prices: a failed price read leaves the cards without a figure, Upgrade still live", async ({ page }) => {
  await page.route("**/api/vexa/billing/prices", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Stripe billing is not configured" }) }),
  );
  await signIn(page, testEmail("billing-prices-down"));
  await page.goto("/billing");

  const proCard = page.getByRole("heading", { name: "Pro" }).locator("..");
  await expect(proCard.getByRole("button", { name: "Upgrade" })).toBeEnabled();
  await expect(page.getByTestId("price-pro")).toHaveCount(0);
});
