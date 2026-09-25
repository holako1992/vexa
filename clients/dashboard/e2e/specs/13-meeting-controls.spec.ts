/** DB-41 (bot controls) + DB-42 (rename, delete, participants) against a REAL running stub. */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("stop recording: shows the confirm dialog, then DELETEs /bots/<platform>/<native>", async ({ page, request }) => {
  await signIn(page, testEmail("stop-recording"));
  await page.goto("/meetings/101"); // live
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();

  await page.getByRole("button", { name: "Stop recording" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop recording?" });
  await expect(dialog).toBeVisible();

  const before = await gatewayRequests(request);
  await dialog.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const after = await gatewayRequests(request);
  const stopCall = after.slice(before.length).find((r) => r.method === "DELETE" && r.url.startsWith("/bots/google_meet/abc-defg-hij"));
  expect(stopCall).toBeTruthy();
});

test("rename: inline edit writes through POST /meetings/<id>/annotate, not PATCH", async ({ page, request }) => {
  await signIn(page, testEmail("rename"));
  await page.goto("/meetings/105");
  await expect(page.getByRole("heading", { name: "Support Retro" })).toBeVisible();

  await page.getByRole("button", { name: "Rename meeting" }).click();
  const input = page.getByRole("textbox", { name: "Meeting title" });
  await input.fill("Support Retro — Sept 19");

  const before = await gatewayRequests(request);
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("heading", { name: "Support Retro — Sept 19" })).toBeVisible();

  const after = await gatewayRequests(request);
  const writes = after.slice(before.length);
  expect(writes.some((r) => r.method === "POST" && r.url === "/meetings/105/annotate")).toBe(true);
  expect(writes.some((r) => r.method === "PATCH" && r.url.startsWith("/meetings/105"))).toBe(false);
});

test("delete: confirm dialog names what is lost, then returns to the list with a toast", async ({ page, request }) => {
  await signIn(page, testEmail("delete"));
  await page.goto("/meetings/105");
  await expect(page.getByRole("heading", { name: "Support Retro" })).toBeVisible();

  await page.getByRole("button", { name: "Delete meeting" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this meeting?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/permanently deletes the transcript/i)).toBeVisible();

  const before = await gatewayRequests(request);
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Meeting deleted.")).toBeVisible();

  const after = await gatewayRequests(request);
  expect(after.slice(before.length).some((r) => r.method === "DELETE" && r.url === "/meetings/105")).toBe(true);
});

test("participants render in the header for a meeting with a roster", async ({ page }) => {
  await signIn(page, testEmail("participants"));
  await page.goto("/meetings/101"); // the only fixture meeting with a PARTICIPANTS entry
  await expect(page.getByText("Participants")).toBeVisible();
  await expect(page.getByText(/Amy.*invite/)).toBeVisible();
  await expect(page.getByText(/Amy.*speaker/)).toBeVisible();
  await expect(page.getByText(/Ben.*invite/)).toBeVisible();
});

test("a shared meeting shows no rename, delete, or stop control", async ({ page }) => {
  await signIn(page, testEmail("shared-no-controls"));
  await page.goto("/meetings/104"); // shared: true
  await expect(page.getByRole("heading", { name: "Daily Standup" })).toBeVisible();

  await expect(page.getByRole("button", { name: "Rename meeting" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete meeting" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop recording" })).toHaveCount(0);
});
