/** Property 2 — sign-in through the email door lands on the meetings list and sets the session
 *  cookies.
 *
 *  Expected: submitting the email form on /login navigates to / (the meetings list) and the
 *  browser now holds both `vexa-token` and `vexa-user-info` cookies.
 */
import { test, expect } from "@playwright/test";
import { resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("email sign-in lands on the meetings list and sets both session cookies", async ({ page, context }) => {
  await signIn(page, testEmail("signin"));

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();

  const cookies = await context.cookies();
  const names = cookies.map((c) => c.name);
  expect(names).toContain("vexa-token");
  expect(names).toContain("vexa-user-info");
});
