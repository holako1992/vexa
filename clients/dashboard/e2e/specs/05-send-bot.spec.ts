/** Property 5 — sending a bot: paste a Google Meet URL, watch the platform chip appear, send,
 *  and the stub gateway receives `POST /bots` with the parsed platform + native id.
 *
 *  Expected: pasting `https://meet.google.com/new-cafe-bot` shows a "Google Meet" chip with the
 *  parsed id, clicking "Send Bot" posts exactly that platform/id pair to the stub.
 */
import { test, expect } from "@playwright/test";
import { dispatchedBots, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("paste a Google Meet URL, see the platform chip, send, and the gateway receives POST /bots", async ({ page, request }) => {
  await signIn(page, testEmail("sendbot"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await expect(dialog).toBeVisible();

  const urlInput = dialog.getByLabel("Meeting URL");
  await urlInput.fill("https://meet.google.com/new-cafe-bot");

  // Scoped to the dialog: the meetings list behind it also shows a "Google Meet" platform label
  // (Weekly Sync, a fixture row), which would otherwise make this locator ambiguous.
  await expect(dialog.getByText("Google Meet", { exact: false }).filter({ hasText: "new-cafe-bot" })).toBeVisible();

  await dialog.getByRole("button", { name: "Send Bot" }).click();
  await expect(dialog.getByText("Bot is joining the meeting.")).toBeVisible();

  const bots = await dispatchedBots(request);
  expect(bots).toHaveLength(1);
  expect(bots[0]).toMatchObject({ platform: "google_meet", native_meeting_id: "new-cafe-bot" });
});
