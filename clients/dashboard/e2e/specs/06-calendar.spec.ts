/** Property 6 — connecting a calendar: add an ICS connection (`POST /user/calendars`), then
 *  toggle auto-join (`PATCH /user/calendars/<id>`).
 *
 *  Expected: filling the "Connect a calendar" form and submitting posts to the stub and the new
 *  connection appears in the list; toggling its auto-join switch sends a PATCH with the flipped
 *  value.
 */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("connect an ICS calendar, then toggle auto-join", async ({ page, request }) => {
  await signIn(page, testEmail("calendar"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();

  await page.getByRole("button", { name: "Connect a calendar" }).click();
  await page.getByLabel("Name").fill("Work calendar");
  await page.getByLabel("Secret ICS address").fill("https://calendar.example.com/secret/basic.ics");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText("Work calendar")).toBeVisible();

  const afterConnect = await gatewayRequests(request);
  const connectCall = afterConnect.find((r) => r.method === "POST" && r.url === "/user/calendars");
  expect(connectCall).toBeTruthy();

  // Expand the row, then flip auto-join.
  await page.getByRole("button", { name: "Expand" }).click();
  await expect(page.getByText("Auto-join meetings from this calendar")).toBeVisible();
  await page.getByRole("checkbox").click();

  await expect
    .poll(async () => {
      const reqs = await gatewayRequests(request);
      return reqs.some((r) => r.method === "PATCH" && /^\/user\/calendars\/\d+$/.test(r.url));
    })
    .toBe(true);
});
