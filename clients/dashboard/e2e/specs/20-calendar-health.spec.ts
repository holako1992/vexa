/** DB-34 — `/calendar`: per-connection health (last sync, last error, events touched) and
 *  Reconnect for a connection whose grant needs it. A failed feed shows that action (ICS: "Sync
 *  now" again; Google/Microsoft: "Reconnect") rather than going silently stale.
 */
import { test, expect } from "@playwright/test";
import { E2E_GOOGLE_EMAIL } from "../fixtures.mjs";
import {
  gatewayRequests,
  resetStub,
  seedCalendar,
  seedSyncStamp,
  signIn,
  testEmail,
} from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("no calendars connected points at the Add Bot dialog's Calendar tab, never a placeholder", async ({ page }) => {
  await signIn(page, testEmail("calendar-health-empty"));
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.waitForURL("**/calendar");

  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(page.getByText("No calendars connected")).toBeVisible();
  await expect(page.getByText(/add bot.*calendar tab/i)).toBeVisible();
});

test("shows last sync time and events touched after syncing a healthy ICS connection", async ({ page, request }) => {
  await seedCalendar(request, {
    id: "cal-health-ics",
    kind: "ics",
    name: "Team calendar",
    ics_url_set: true,
    ics_url_masked: "calendar.example.com/…/1234",
    auto_join: true,
    enabled: true,
  });
  await signIn(page, testEmail("calendar-health-ics-sync"));
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.waitForURL("**/calendar");

  const row = page.getByRole("group", { name: "Team calendar" });
  await expect(row.getByText("Never synced")).toBeVisible();

  await row.getByRole("button", { name: "Sync now" }).click();

  await expect(row.getByText(/last synced/i)).toBeVisible();
  await expect(row.getByText("1 event touched")).toBeVisible();

  const syncCall = (await gatewayRequests(request)).find(
    (r) => r.method === "POST" && r.url === "/user/calendars/cal-health-ics/sync",
  );
  expect(syncCall).toBeTruthy();
});

test("shows the producer's last_error verbatim on a failed feed, with Sync now still offered (ICS)", async ({ page, request }) => {
  await seedCalendar(request, {
    id: "cal-health-broken",
    kind: "ics",
    name: "Broken feed",
    ics_url_set: true,
    ics_url_masked: "calendar.example.com/…/9999",
    auto_join: true,
    enabled: true,
  });
  await seedSyncStamp(request, "cal-health-broken", {
    last_sync: "2026-09-20T09:00:00Z",
    last_error: "the feed couldn't be parsed as an ICS calendar",
    counts: null,
  });
  await signIn(page, testEmail("calendar-health-ics-broken"));
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.waitForURL("**/calendar");

  const row = page.getByRole("group", { name: "Broken feed" });
  await expect(row.getByText("the feed couldn't be parsed as an ICS calendar")).toBeVisible();
  await expect(row.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
});

test("a Google connection needing reconnect shows Reconnect, not Sync now, and clears on success", async ({ page, request }) => {
  await seedCalendar(request, {
    kind: "google",
    name: `Google — ${E2E_GOOGLE_EMAIL}`,
    google_email: E2E_GOOGLE_EMAIL,
    google_calendar_ids: ["primary"],
    reconnect_needed: true,
    auto_join: true,
    bot_name: "Vexa",
    enabled: true,
  });
  await page.route("https://accounts.google.com/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const state = requestUrl.searchParams.get("state") ?? "";
    const query = new URLSearchParams({ code: "e2e-test-code", state }).toString();
    await route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:3100/calendar/google/callback?${query}` } });
  });

  await signIn(page, testEmail("calendar-health-reconnect"));
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.waitForURL("**/calendar");

  const row = page.getByRole("group", { name: `Google — ${E2E_GOOGLE_EMAIL}` });
  await expect(row.getByText("Reconnect needed")).toBeVisible();
  await expect(row.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await row.getByRole("button", { name: "Reconnect" }).click();

  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Google Calendar connected" })).toBeVisible();
});
