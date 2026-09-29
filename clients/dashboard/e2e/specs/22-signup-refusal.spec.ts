/** A refused sign-up says why, and the sign-up carries the user's address to admin-api.
 *
 *  Expected: signing in with a disposable-domain address through the email door shows the fixed
 *  readable refusal (not admin-api's JSON) and sets no session; `/login?error=<code>` shows the
 *  copy for a known code and only the generic sentence for anything else — a hostile value is
 *  never reflected; and the stub's admin-api received the caller's `X-Forwarded-For` on the
 *  create call.
 */
import { test, expect } from "@playwright/test";
import { adminRequests, resetStub, signIn, testEmail } from "./helpers";

/** The login card's own message. `getByRole("alert")` alone would also match Next dev's empty
 *  route announcer. */
const REFUSAL = "p[role=alert]";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("a disposable-domain sign-up shows the readable refusal and no session", async ({ page, context }) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": "10.98.0.1" });
  await page.goto("/login");
  await page.getByLabel("Email").fill("disposable-one@e2e.test");
  await page.getByRole("button", { name: "Continue" }).click();

  const alert = page.locator(REFUSAL);
  await expect(alert).toContainText("disposable or throwaway");
  await expect(alert).not.toContainText("detail");
  await expect(alert).not.toContainText("{");
  await expect(page).toHaveURL(/\/login/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain("vexa-token");
});

test("/login?error= maps known codes to fixed copy and never reflects other text", async ({ page }) => {
  await page.goto("/login?error=disposable_email_domain");
  await expect(page.locator(REFUSAL)).toContainText("disposable or throwaway");

  await page.goto("/login?error=" + encodeURIComponent("<b>pwned</b> call 555-0100"));
  const alert = page.locator(REFUSAL);
  await expect(alert).toContainText("couldn't sign you in");
  await expect(alert).not.toContainText("pwned");

  await page.goto("/login");
  await expect(page.locator(REFUSAL)).toHaveCount(0);
});

test("the create call carries the caller's X-Forwarded-For to admin-api", async ({ page, request }) => {
  await signIn(page, testEmail("xff"));
  const create = (await adminRequests(request)).find((r) => r.method === "POST" && r.url === "/admin/users");
  expect(create).toBeTruthy();
  expect(create!.headers["x-forwarded-for"]).toMatch(/^10\.99\.0\.\d+$/);
});
