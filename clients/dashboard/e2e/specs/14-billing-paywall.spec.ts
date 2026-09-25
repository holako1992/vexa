/** DB-74 (billing page, read-only half) and DB-75 (paywall / upgrade prompts) — against a REAL
 *  running stub, like every other spec in this directory.
 *
 *  Expected:
 *   - `/billing` renders the plan name, a meetings meter, minutes used, and the reset date, in
 *     each of four entitlements states: free with room left, free exhausted, pro unlimited, and
 *     usage the meter hasn't reported yet (which must show "Usage unavailable", never "0").
 *   - a past-due plan shows its grace-period note.
 *   - the Send-Bot dialog shows a remaining-allowance line under Send for a finite plan.
 *   - a `POST /bots` refused with DB-72's unwrapped 402 `quota_exceeded` body shows the paywall
 *     message (what happened, when it resets) and a link — to `upgrade_url` when the body carries
 *     one, else to `/billing`.
 *   - the summary panel's `_none recorded in this meeting._` placeholder renders as italic text,
 *     never literal underscores (the rendering bug this bundle also fixes).
 */
import { test, expect } from "@playwright/test";
import {
  freeEntitlements,
  proUnlimitedEntitlements,
  pastDueEntitlements,
  unknownUsageEntitlements,
} from "../fixtures.mjs";
import { forceBotsQuotaExceeded, resetStub, setEntitlements, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("billing page: free plan with room left", async ({ page, request }) => {
  await setEntitlements(request, freeEntitlements({ used: 0 }));
  await signIn(page, testEmail("billing-free"));

  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText("Free plan")).toBeVisible();
  await expect(page.getByText("0 of 1 meetings used")).toBeVisible();
  await expect(page.getByText("Resets 1 October")).toBeVisible();
});

test("billing page: free plan exhausted", async ({ page, request }) => {
  await setEntitlements(request, freeEntitlements({ used: 1 }));
  await signIn(page, testEmail("billing-exhausted"));

  await page.goto("/billing");
  await expect(page.getByText("1 of 1 meetings used")).toBeVisible();
});

test("billing page: pro plan is unlimited, regardless of usage", async ({ page, request }) => {
  await setEntitlements(request, proUnlimitedEntitlements());
  await signIn(page, testEmail("billing-pro"));

  await page.goto("/billing");
  await expect(page.getByText("Pro plan")).toBeVisible();
  await expect(page.getByText("Unlimited")).toBeVisible();
});

test("billing page: past_due shows the grace-period note", async ({ page, request }) => {
  await setEntitlements(request, pastDueEntitlements());
  await signIn(page, testEmail("billing-pastdue"));

  await page.goto("/billing");
  await expect(page.getByText(/payment past due/i)).toBeVisible();
  await expect(page.getByText(/grace period until 8 October/i)).toBeVisible();
});

test("billing page: unknown usage never renders as 0", async ({ page, request }) => {
  await setEntitlements(request, unknownUsageEntitlements());
  await signIn(page, testEmail("billing-unknown"));

  await page.goto("/billing");
  const meetingsRow = page.getByText("Meetings this period").locator("..");
  await expect(meetingsRow.getByText("Usage unavailable")).toBeVisible();
  await expect(meetingsRow.getByText(/^0/)).toHaveCount(0);
});

test("send-bot dialog: shows the remaining allowance for a finite plan", async ({ page, request }) => {
  await setEntitlements(request, freeEntitlements({ used: 0 }));
  await signIn(page, testEmail("paywall-remaining"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await expect(dialog.getByText("1 of 1 free meetings left this month · resets 1 October")).toBeVisible();
});

test("send-bot dialog: a quota_exceeded refusal shows the paywall message with a billing link", async ({ page, request }) => {
  await setEntitlements(request, freeEntitlements({ used: 1 }));
  await forceBotsQuotaExceeded(request, true);
  await signIn(page, testEmail("paywall-refused"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await dialog.getByLabel("Meeting URL").fill("https://meet.google.com/abc-quiz-bot");
  await dialog.getByRole("button", { name: "Send Bot" }).click();

  const quotaMessage = dialog.getByRole("status");
  await expect(quotaMessage.getByText(/you.ve used your 1 meeting for this billing period/i)).toBeVisible();
  await expect(quotaMessage.getByText(/resets 1 october/i)).toBeVisible();
  const link = dialog.getByRole("link", { name: "See billing" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/billing");
});

test("send-bot dialog: the client never disables Send from a stale entitlements read", async ({ page, request }) => {
  // Free, exhausted per the entitlements read — but the client must still let the user TRY; the
  // server (the stub, standing in for it) is the one that refuses. Send stays enabled here on
  // purpose (no forceBotsQuotaExceeded): a stale client number must never block a legitimate send.
  await setEntitlements(request, freeEntitlements({ used: 1 }));
  await signIn(page, testEmail("paywall-no-client-block"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await dialog.getByLabel("Meeting URL").fill("https://meet.google.com/abc-slow-bot");
  await expect(dialog.getByRole("button", { name: "Send Bot" })).toBeEnabled();
});

test("summary: the producer's emphasis placeholder renders as italic, not literal underscores", async ({ page }) => {
  await signIn(page, testEmail("summary-emphasis"));
  await page.goto("/meetings/102"); // fixture summary's Open questions section is exactly this placeholder

  const openQuestions = page.getByText("Open questions").locator("..");
  await expect(openQuestions.getByText("none recorded in this meeting.")).toBeVisible();
  await expect(page.getByText("_none recorded in this meeting._")).toHaveCount(0);
  const em = openQuestions.locator("em", { hasText: "none recorded in this meeting." });
  await expect(em).toHaveCount(1);
});
