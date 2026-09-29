/** Sign-in provenance and the unverified-identity paywall copy.
 *
 *  Expected: the dev email door's create call carries `identity_provider: "email"` and
 *  `email_verified: false`, and a returning email-door sign-in sends no provenance update; and an
 *  account whose entitlements state `identity_unverified` sees the fixed explanation on /billing
 *  and in the Send-Bot dialog (both the allowance line and the refusal), with no plan link on the
 *  refusal, and never the raw reason code.
 */
import { test, expect } from "@playwright/test";
import { identityUnverifiedEntitlements } from "../fixtures.mjs";
import { adminRequests, forceBotsQuotaExceeded, resetStub, setEntitlements, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

const EXPLANATION = /email address isn.t verified/i;

test("the email door's create call carries email_verified false", async ({ page, request }) => {
  await signIn(page, testEmail("provenance"));
  const create = (await adminRequests(request)).find((r) => r.method === "POST" && r.url === "/admin/users");
  expect(create).toBeTruthy();
  expect(create!.body).toMatchObject({ identity_provider: "email", email_verified: false });
});

test("a returning email-door sign-in sends no provenance update", async ({ page, request }) => {
  const email = testEmail("provenance-again");
  await signIn(page, email);
  await page.context().clearCookies();
  await signIn(page, email);
  const patches = (await adminRequests(request)).filter((r) => r.method === "PATCH");
  expect(patches).toHaveLength(0);
});

test("billing page explains an unverified identity in fixed words", async ({ page, request }) => {
  await setEntitlements(request, identityUnverifiedEntitlements());
  await signIn(page, testEmail("unverified-billing"));
  await page.goto("/billing");
  await expect(page.getByText(EXPLANATION)).toBeVisible();
  await expect(page.getByText("identity_unverified")).toHaveCount(0);
});

test("send-bot dialog: the allowance line and the refusal both explain it, with no plan link", async ({ page, request }) => {
  await setEntitlements(request, identityUnverifiedEntitlements());
  await forceBotsQuotaExceeded(request, "identity_unverified");
  await signIn(page, testEmail("unverified-send"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await expect(dialog.getByText(EXPLANATION)).toBeVisible();

  await dialog.getByLabel("Meeting URL").fill("https://meet.google.com/abc-unvr-bot");
  await dialog.getByRole("button", { name: "Send Bot" }).click();
  const refusal = dialog.getByRole("status");
  await expect(refusal.getByText(EXPLANATION)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "See billing" })).toHaveCount(0);
  await expect(dialog.getByText("identity_unverified")).toHaveCount(0);
});
