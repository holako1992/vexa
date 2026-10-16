/** The shared "Connect a calendar" panel (`CalendarConnectPanel`) on the Calendar page: the in-app
 *  ICS guide per provider, connecting an ICS link right there, "Add calendar" once one exists, and
 *  a Google connect started on this page coming back to it.
 *
 *  Expected:
 *   - "Use another calendar" opens the guide on the Google tab: numbered steps, and an "Open
 *     Google Calendar settings" link to Google's own settings page in a new tab. The Outlook tab
 *     names "Publish a calendar" and links the work and personal Outlook settings pages.
 *   - Pasting a link there connects it (`POST /user/calendars`) and the new row appears.
 *   - With a calendar connected, the panel is behind "Add calendar".
 *   - Connect Google Calendar from this page lands back on /calendar (not the meetings page),
 *     with a "Google Calendar connected." toast and the query cleared.
 */
import { test, expect } from "@playwright/test";
import { DASHBOARD_URL } from "../ports.mjs";
import { gatewayRequests, resetStub, seedCalendar, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

async function openCalendarPage(page: import("@playwright/test").Page, tag: string) {
  await signIn(page, testEmail(tag));
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.waitForURL("**/calendar");
}

test("the ICS guide walks through each provider and links its own settings page", async ({ page }) => {
  await openCalendarPage(page, "calendar-guide");
  await page.getByRole("button", { name: /Use another calendar/ }).click();

  const guide = page.getByTestId("ics-guide");
  await expect(guide.getByRole("tab", { name: "Google" })).toHaveAttribute("aria-selected", "true");
  await expect(guide.getByText("Secret address in iCal format", { exact: false })).toBeVisible();
  const googleSettings = guide.getByRole("link", { name: "Open Google Calendar settings" });
  await expect(googleSettings).toHaveAttribute("href", "https://calendar.google.com/calendar/r/settings");
  await expect(googleSettings).toHaveAttribute("target", "_blank");

  await guide.getByRole("tab", { name: "Outlook / Microsoft 365" }).click();
  await expect(guide.getByText("Publish a calendar", { exact: false }).first()).toBeVisible();
  await expect(guide.getByRole("link", { name: "Open Outlook settings (work or school)" }))
    .toHaveAttribute("href", "https://outlook.office.com/calendar/options/calendar/SharedCalendars");
  await expect(guide.getByRole("link", { name: "Outlook.com (personal)" }))
    .toHaveAttribute("href", "https://outlook.live.com/calendar/0/options/calendar/SharedCalendars");

  await guide.getByRole("tab", { name: "Apple iCloud" }).click();
  await expect(guide.getByText("replace that with https://", { exact: false })).toBeVisible();
});

test("an ICS link pasted on the Calendar page connects and appears in the list", async ({ page, request }) => {
  await openCalendarPage(page, "calendar-page-ics");
  await page.getByRole("button", { name: /Use another calendar/ }).click();
  await page.getByLabel("Paste your calendar's ICS link").fill("https://calendar.example.com/secret/page.ics");
  await page.getByLabel("Name").fill("Page calendar");
  await page.getByRole("button", { name: "Connect calendar", exact: true }).click();

  await expect(page.getByRole("group", { name: "Page calendar" })).toBeVisible();
  const reqs = await gatewayRequests(request);
  expect(reqs.some((r) => r.method === "POST" && r.url === "/user/calendars")).toBe(true);
  // The panel folds away once something is connected; "Add calendar" brings it back.
  await expect(page.getByTestId("calendar-connect-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Add calendar" }).click();
  await expect(page.getByTestId("calendar-connect-panel")).toBeVisible();
});

test("a Google connect started on the Calendar page comes back to it", async ({ page, request }) => {
  await seedCalendar(request, {
    kind: "ics",
    name: "Existing feed",
    ics_url_set: true,
    ics_url_masked: "calendar.example.com/…/1",
    auto_join: true,
    enabled: true,
  });
  await page.route("https://accounts.google.com/**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state") ?? "";
    const query = new URLSearchParams({ code: "e2e-test-code", state }).toString();
    await route.fulfill({ status: 302, headers: { location: `${DASHBOARD_URL}/calendar/google/callback?${query}` } });
  });

  await openCalendarPage(page, "calendar-page-google");
  await page.getByRole("button", { name: "Add calendar" }).click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();

  await page.waitForURL(/\/calendar\/google\/callback/);
  await page.getByRole("button", { name: "Back to Calendar" }).click();

  await page.waitForURL(/\/calendar(\?.*)?$/);
  await expect(page.getByRole("status").filter({ hasText: "Google Calendar connected." })).toBeVisible();
  await expect(page).toHaveURL(`${DASHBOARD_URL}/calendar`);
});
