/** One subscription, switched in place: a subscriber's plan cards offer "Switch to …" instead of
 *  checkout, a confirmation says when the switch takes effect and what it bills, and the page
 *  shows a switch scheduled for the period end with a way to keep the current plan.
 *
 *  Expected:
 *   - A Pro monthly subscriber sees "Current plan" on Pro monthly and "Switch to Team" on Team;
 *     confirming Team monthly sends `POST /billing/change {plan:'team', interval:'month'}`, says
 *     nothing is charged today, and the page then shows Team as current.
 *   - Switching Pro monthly → Pro yearly is scheduled: the page shows "Switching to Pro yearly on …"
 *     and "Keep Pro monthly" calls it off.
 *   - A checkout refused with 409 (a second subscription) shows an explanatory toast.
 */
import { test, expect } from "@playwright/test";
import { proMonthlySubscriberEntitlements } from "../fixtures.mjs";
import { gatewayRequests, resetStub, setEntitlements, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

const card = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("heading", { name, exact: true }).locator("..");

test("a subscriber's cards switch rather than buy, and an upgrade applies now", async ({ page, request }) => {
  await setEntitlements(request, proMonthlySubscriberEntitlements());
  await signIn(page, testEmail("billing-switch-up"));
  await page.goto("/billing");

  await expect(page.getByRole("heading", { name: "Change your plan" })).toBeVisible();
  await expect(card(page, "Pro").getByRole("button", { name: "Current plan" })).toBeDisabled();
  await card(page, "Team").getByRole("button", { name: "Switch to Team" }).click();

  const dialog = page.getByRole("dialog", { name: "Switch to Team monthly?" });
  await expect(dialog.getByTestId("switch-explanation")).toContainText("Team starts now. Nothing is charged today");
  await expect(dialog.getByTestId("switch-explanation")).toContainText("$20 / month");
  await dialog.getByRole("button", { name: "Confirm switch" }).click();

  await expect(page.getByRole("status").filter({ hasText: "You're on Team monthly" })).toBeVisible();
  await expect(card(page, "Team").getByRole("button", { name: "Current plan" })).toBeDisabled();
  await expect(page.getByTestId("subscription-line")).toContainText("Team monthly");

  const change = (await gatewayRequests(request)).filter((r) => r.method === "POST" && r.url.includes("/billing/change"));
  expect(change).toHaveLength(1);
  expect(change[0].body).toEqual({ plan: "team", interval: "month" });
});

test("an interval switch is scheduled for the period end and can be called off", async ({ page, request }) => {
  await setEntitlements(request, proMonthlySubscriberEntitlements());
  await signIn(page, testEmail("billing-switch-yearly"));
  await page.goto("/billing");

  await page.getByRole("tab", { name: "Yearly" }).click();
  await card(page, "Pro").getByRole("button", { name: "Switch to yearly" }).click();
  const dialog = page.getByRole("dialog", { name: "Switch to Pro yearly?" });
  await expect(dialog.getByTestId("switch-explanation")).toContainText("You'll keep Pro monthly until");
  await dialog.getByRole("button", { name: "Confirm switch" }).click();

  await expect(page.getByTestId("pending-change")).toContainText("Switching to Pro yearly on");
  await expect(card(page, "Pro").getByRole("button", { name: "Scheduled" })).toBeDisabled();

  await page.getByRole("button", { name: "Keep Pro monthly" }).click();
  await expect(page.getByTestId("pending-change")).toHaveCount(0);
});

test("a refused second checkout explains itself", async ({ page }) => {
  await page.route("**/api/vexa/billing/checkout", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "You already have a subscription" }) }),
  );
  await signIn(page, testEmail("billing-second-checkout"));
  await page.goto("/billing");
  await card(page, "Pro").getByRole("button", { name: "Upgrade" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You already have a subscription" })).toBeVisible();
});
