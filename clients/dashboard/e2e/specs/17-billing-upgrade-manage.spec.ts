/** DB-74b — the two write controls the billing page grows over DB-74/DB-75's read-only page:
 *  Upgrade (`POST /billing/checkout {plan, interval}` → redirect) and Manage subscription
 *  (`POST /billing/portal` → redirect, or a 409 toast when there's no subscription yet).
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
 *   - Manage subscription redirects to the Stripe portal URL when the account has a Stripe
 *     customer on file, and shows an explanatory toast (never a generic error) — with a live
 *     Upgrade button visible on the same page — when the core answers 409 because it doesn't.
 */
import { test, expect } from "@playwright/test";
import { resetStub, setStripeCustomer, signIn, testEmail } from "./helpers";

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

test("manage subscription: no Stripe customer yet shows a toast, never a generic error", async ({ page, request }) => {
  await signIn(page, testEmail("billing-manage-409"));
  await page.goto("/billing");

  await page.getByRole("button", { name: "Manage subscription" }).click();

  const toast = page.getByRole("status").filter({ hasText: "No subscription to manage yet" });
  await expect(toast).toBeVisible();
  await expect(toast.getByText(/upgrade first/i)).toBeVisible();
  // Upgrade is right there on the same page — the toast never has to be the only way forward.
  await expect(page.getByRole("button", { name: "Upgrade" }).first()).toBeEnabled();
});

test("manage subscription: an existing Stripe customer redirects straight to the Portal", async ({ page, request }) => {
  await setStripeCustomer(request, true);
  await signIn(page, testEmail("billing-manage-success"));
  await page.goto("/billing");

  let navigatedTo: string | null = null;
  await page.route("https://billing.stripe.com/**", async (route) => {
    navigatedTo = route.request().url();
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html>stripe portal (e2e stub)</html>" });
  });

  await page.getByRole("button", { name: "Manage subscription" }).click();

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
  await expect(page.getByRole("button", { name: "Manage subscription" })).toBeDisabled();
});
