/** The list, the audio player, click-a-segment-to-seek, and download + delete —
 *  against a REAL running stub — including a REAL HTTP Range request/response for the player,
 *  never a canned header (see `stub-server.mjs`'s `serveRangeableBytes`). Meeting 102 ("Design
 *  Review") is the fixture's one recording: recording id `700001`, audio media file id `800001`.
 */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("the /recordings list shows the fixture recording and links to its meeting", async ({ page }) => {
  await signIn(page, testEmail("recordings-list"));
  await page.getByRole("link", { name: "Recordings" }).click();
  await page.waitForURL("**/recordings");
  await expect(page.getByRole("heading", { name: "Recordings" })).toBeVisible();

  const row = page.getByRole("group", { name: /Recording from/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("Recorded")).toBeVisible();

  await row.getByRole("link", { name: /^\w+ \d+, \d{4}/ }).click(); // the date link, not "Download"
  await page.waitForURL("**/meetings/102");
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();
});

test("the retention note reads the plan's own recording_retention_days", async ({ page }) => {
  await signIn(page, testEmail("recordings-retention"));
  await page.getByRole("link", { name: "Recordings" }).click();
  await page.waitForURL("**/recordings");
  // freeEntitlements() (the stub's default) sets recording_retention_days: 7.
  await expect(page.getByText("Your plan: Kept for 7 days.")).toBeVisible();
});

test("the meeting page's audio player loads via a real Range request and gets a 206", async ({ page }) => {
  await signIn(page, testEmail("recordings-player"));
  const rangeResponse = page.waitForResponse(
    (res) => res.url().includes("/media/800001/raw") && res.status() === 206,
  );
  await page.goto("/meetings/102");
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();
  await expect(page.locator("audio")).toBeVisible();

  const response = await rangeResponse;
  expect(response.status()).toBe(206);
  expect(response.headers()["content-range"]).toMatch(/^bytes \d+-\d+\/\d+$/);
  expect(response.headers()["accept-ranges"]).toBe("bytes");
});

test("clicking a transcript segment seeks the player to its own start and highlights it while playing", async ({ page }) => {
  await signIn(page, testEmail("recordings-seek"));
  await page.goto("/meetings/102");
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();

  const audio = page.locator("audio");
  await expect(audio).toBeVisible();
  // Wait for real metadata (duration) so the coming `currentTime` write isn't clamped to 0 by a
  // player that hasn't finished loading yet.
  await page.waitForFunction(() => (document.querySelector("audio")?.readyState ?? 0) >= 1);

  // TRANSCRIPTS[102][1] in fixtures.mjs: { start: 8.5, speaker: "Dev", ... } → formatClock(8.5) = "0:08".
  const segment = page.getByRole("button", { name: "Play from 0:08" });
  await segment.click();

  await page.waitForFunction(() => {
    const el = document.querySelector("audio") as HTMLAudioElement | null;
    return !!el && el.currentTime >= 8 && el.currentTime < 9;
  });
  await expect(segment).toHaveClass(/ring-accent/);
});

test("the download link points at the media download route and actually serves audio", async ({ page }) => {
  await signIn(page, testEmail("recordings-download"));
  await page.getByRole("link", { name: "Recordings" }).click();
  await page.waitForURL("**/recordings");

  const link = page.getByRole("link", { name: "Download" });
  const href = await link.getAttribute("href");
  expect(href).toBe("/api/vexa/recordings/700001/media/800001/download?type=audio");
  await expect(link).toHaveAttribute("download", "");

  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("audio/wav");
});

test("delete: confirm dialog, DELETEs /recordings/<id>, and the row disappears with a toast", async ({ page, request }) => {
  await signIn(page, testEmail("recordings-delete"));
  await page.getByRole("link", { name: "Recordings" }).click();
  await page.waitForURL("**/recordings");

  await page.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this recording?" });
  await expect(dialog).toBeVisible();

  const before = await gatewayRequests(request);
  await dialog.getByRole("button", { name: "Delete" }).click();

  await expect(page.getByText("Recording deleted.")).toBeVisible();
  await expect(page.getByRole("group", { name: /Recording from/ })).toHaveCount(0);
  await expect(page.getByText("No recordings yet.")).toBeVisible();

  const after = await gatewayRequests(request);
  expect(after.slice(before.length).some((r) => r.method === "DELETE" && r.url === "/recordings/700001")).toBe(true);
});
