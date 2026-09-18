/** Property 4 — the detail page opens ONE meeting by row id and never scans the list (DB-05,
 *  `b92d8de1`). Nothing has exercised this end to end before this spec.
 *
 *  Expected: opening meeting 102 renders its transcript with speaker attribution, and the
 *  gateway's own request log shows a `GET /meetings/102` was made and NO further bare
 *  `GET /meetings` was made after navigating to the detail page.
 */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("opens one meeting by row id, renders its transcript, and requests only /meetings/<id>", async ({ page, request }) => {
  await signIn(page, testEmail("detail"));
  // signIn only waits for the "Meetings" heading, which is static markup rendered before the
  // list's own client-side `GET /meetings` has resolved. Wait for a fixture row to actually
  // render, so the snapshot below is taken AFTER that first load, not mid-flight.
  await page.getByRole("heading", { name: "Design Review" }).waitFor();

  const beforeNav = await gatewayRequests(request);

  await page.getByRole("heading", { name: "Design Review" }).click();
  await expect(page).toHaveURL(/\/meetings\/102$/);
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();

  // Multi-speaker transcript with attribution — both speakers' lines render.
  await expect(page.getByText("Let's start with the new onboarding flow.")).toBeVisible();
  await expect(page.getByText("Sure — I pushed the updated mockups last night.")).toBeVisible();
  await expect(page.getByText("Carla", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Dev", { exact: true }).first()).toBeVisible();

  const afterNav = await gatewayRequests(request);
  const newCalls = afterNav.slice(beforeNav.length).map((r) => r.url.split("?")[0]);

  expect(newCalls).toContain("/meetings/102");
  expect(newCalls).not.toContain("/meetings");
});

test("a foreign/unknown id is a 404 from the gateway, not a list scan", async ({ page, request }) => {
  await signIn(page, testEmail("detail-404"));
  await page.getByRole("heading", { name: "Design Review" }).waitFor();
  const before = await gatewayRequests(request);

  await page.goto("/meetings/999999");
  await expect(page.getByText("That meeting isn't in your list.")).toBeVisible();

  const after = await gatewayRequests(request);
  const newCalls = after.slice(before.length).map((r) => r.url.split("?")[0]);
  expect(newCalls).toContain("/meetings/999999");
  expect(newCalls).not.toContain("/meetings");
});
