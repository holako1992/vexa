/** Property 9 — failure is not emptiness (src/components/EmptyState.tsx exists to make this
 *  distinction possible; this is the first thing that actually exercises it against a server).
 *
 *  Expected: a 500 from `GET /meetings` renders the list's error state with a retry button, not
 *  "No meetings yet." A 404 from `GET /meetings/<id>` renders the detail page's not-found state,
 *  not the generic error state.
 */
import { test, expect } from "@playwright/test";
import { forceMeetingDetail, forceMeetingsList, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("a 500 from /meetings shows the error state with retry, not an empty list", async ({ page, request }) => {
  await forceMeetingsList(request, 500);
  await signIn(page, testEmail("fail-list"));

  // Scoped to <main>: `next dev` also renders its own floating Dev Tools button, which carries an
  // unrelated `role="alert"` node outside the app's content — the unscoped locator is ambiguous.
  const main = page.locator("main");
  await expect(main.getByRole("alert")).toBeVisible();
  await expect(page.getByText("No meetings yet.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a 404 from /meetings/<id> shows not-found on the detail page, not the error state", async ({ page, request }) => {
  await signIn(page, testEmail("fail-detail"));
  await forceMeetingDetail(request, 404);

  await page.goto("/meetings/102");
  await expect(page.getByText("That meeting isn't in your list.")).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
});
