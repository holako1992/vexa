/** Property 10 — DB-04's accessibility claim, proven with Playwright rather than a Lighthouse
 *  score this harness cannot honestly measure (see `README.md`).
 *
 *  Expected:
 *   1. The whole "Add Bot" flow — open the dialog, fill the meeting URL, send — completes with
 *      no mouse click on anything inside the dialog.
 *   2. Once open, Tab is trapped inside the dialog (it never reaches the page behind it), and
 *      Escape closes it and returns focus to the "Add Bot" button that opened it.
 *   3. The calendar auto-join control is a real `role="switch"` and Space toggles it.
 */
import { test, expect } from "@playwright/test";
import { resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("the Add Bot flow opens, fills and sends by keyboard alone", async ({ page }) => {
  await signIn(page, testEmail("a11y-kbd"));

  const opener = page.getByRole("button", { name: "Add Bot" });
  await opener.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await expect(dialog).toBeVisible();

  // Focus landed inside the dialog, not left behind on the page.
  const focusInDialog = await page.evaluate(() => {
    const active = document.activeElement;
    const panel = document.querySelector('[role="dialog"]');
    return !!active && !!panel && panel.contains(active);
  });
  expect(focusInDialog).toBe(true);

  // No mouse from here: focus the field with the keyboard-reachable label lookup and type.
  await dialog.getByLabel("Meeting URL").focus();
  await page.keyboard.type("https://meet.google.com/kbd-only-abc");
  await expect(dialog.getByText("Google Meet", { exact: false }).filter({ hasText: "kbd-only-abc" })).toBeVisible();

  // Tab from the URL field to the Send Bot button and activate it with the keyboard.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Send Bot" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(dialog.getByText("Bot is joining the meeting.")).toBeVisible();
});

test("focus is trapped inside the dialog, and Escape returns it to the opener", async ({ page }) => {
  await signIn(page, testEmail("a11y-trap"));

  const opener = page.getByRole("button", { name: "Add Bot" });
  await opener.click();

  const dialog = page.getByRole("dialog", { name: "Add a Vexa Bot" });
  await expect(dialog).toBeVisible();

  // Tab far more times than there are focusable elements in the dialog — if the trap has a leak,
  // focus ends up back on the page (e.g. the search box behind the backdrop).
  for (let i = 0; i < 15; i++) await page.keyboard.press("Tab");

  const stillInDialog = await page.evaluate(() => {
    const active = document.activeElement;
    const panel = document.querySelector('[role="dialog"]');
    return !!active && !!panel && panel.contains(active);
  });
  expect(stillInDialog).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("calendar auto-join is a real switch, operable with the keyboard", async ({ page }) => {
  await signIn(page, testEmail("a11y-switch"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect a calendar" }).click();
  await page.getByLabel("Name").fill("Keyboard calendar");
  await page.getByLabel("Secret ICS address").fill("https://calendar.example.com/secret/kbd.ics");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Keyboard calendar")).toBeVisible();

  await page.getByRole("button", { name: "Expand" }).click();

  const toggle = page.getByRole("switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true"); // the form defaulted auto-join on

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});
