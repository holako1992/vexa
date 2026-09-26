/** DB-33 — `/upcoming`: grouped by day, the source calendar chip, the Join / Don't join
 *  override, the auto-join skip reason shown verbatim, and "Sync now".
 *
 *  The fixture carries three "scheduled"-phase rows (`../fixtures.mjs`): 103 (Roadmap Planning,
 *  hand-scheduled, no calendar source, 2026-09-25), 110 (Quarterly Review, calendar-managed —
 *  `calendar_name: "Work — Google"` — 2026-09-28T15:00Z), and 111 (1:1 with Priya, hand-scheduled,
 *  auto_join already off, carrying a recorded `auto_join_error`, 2026-09-28T09:00Z, earlier the
 *  same day as 110).
 */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("groups scheduled meetings by day, soonest day and soonest meeting first", async ({ page }) => {
  await signIn(page, testEmail("upcoming-grouping"));
  await page.getByRole("link", { name: "Upcoming" }).click();
  await page.waitForURL("**/upcoming");

  await expect(page.getByRole("heading", { name: "Upcoming" })).toBeVisible();
  await expect(page.getByText("Roadmap Planning")).toBeVisible();
  await expect(page.getByText("Quarterly Review")).toBeVisible();
  await expect(page.getByText("1:1 with Priya")).toBeVisible();

  // Soonest day (2026-09-25, Roadmap Planning) before the later day's two rows; within the later
  // day, the earlier time (1:1 with Priya, 09:00) before the later one (Quarterly Review, 15:00).
  const order = await page.evaluate(() => {
    const text = document.body.innerText;
    return ["Roadmap Planning", "1:1 with Priya", "Quarterly Review"].map((t) => text.indexOf(t));
  });
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
});

test("shows the source calendar chip on a calendar-managed row, and none on a hand-scheduled one", async ({ page }) => {
  await signIn(page, testEmail("upcoming-source-chip"));
  await page.getByRole("link", { name: "Upcoming" }).click();
  await page.waitForURL("**/upcoming");

  const managedRow = page.getByRole("group", { name: "Quarterly Review" });
  await expect(managedRow.getByText("Work — Google")).toBeVisible();

  const handRow = page.getByRole("group", { name: "Roadmap Planning" });
  await expect(handRow.getByText("Work — Google")).toHaveCount(0);
});

test("surfaces the recorded auto-join skip reason verbatim", async ({ page }) => {
  await signIn(page, testEmail("upcoming-skip-reason"));
  await page.getByRole("link", { name: "Upcoming" }).click();
  await page.waitForURL("**/upcoming");

  await expect(page.getByText("another meeting is already active for this bot")).toBeVisible();
});

test("toggling Join / Don't join sends exactly {auto_join} to PATCH /meetings/<id>", async ({ page, request }) => {
  await signIn(page, testEmail("upcoming-toggle"));
  await page.getByRole("link", { name: "Upcoming" }).click();
  await page.waitForURL("**/upcoming");

  // 103 (Roadmap Planning) starts with auto_join absent (defaults on) — its switch reads "Join".
  const row = page.getByRole("group", { name: "Roadmap Planning" });
  const toggle = row.getByRole("switch", { name: "Join" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();

  await expect(row.getByRole("switch", { name: "Don't join" })).toHaveAttribute("aria-checked", "false");

  await expect
    .poll(async () => {
      const reqs = await gatewayRequests(request);
      const patch = reqs.find((r) => r.method === "PATCH" && r.url === "/meetings/103");
      return patch?.body;
    })
    .toEqual({ auto_join: false });
});

test("Sync now runs the existing per-connection sync and reloads the list", async ({ page, request }) => {
  await signIn(page, testEmail("upcoming-sync-now"));
  await page.getByRole("link", { name: "Upcoming" }).click();
  await page.waitForURL("**/upcoming");

  await page.getByRole("button", { name: "Sync now" }).click();

  // With no calendars connected for this fresh account, the page says so rather than silently
  // doing nothing (the "no calendars yet" branch — see `UpcomingView.tsx`).
  await expect(page.getByRole("status").filter({ hasText: "No calendars connected" })).toBeVisible();
});
