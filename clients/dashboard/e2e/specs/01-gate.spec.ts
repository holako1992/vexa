/** Property 1 — the gate (src/middleware.ts).
 *
 *  Expected: an anonymous page request is redirected to /login; an anonymous /api/vexa/* request
 *  gets a 401 JSON body, not a redirect, because a fetch caller cannot usefully follow one.
 */
import { test, expect } from "@playwright/test";
import { resetStub } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("anonymous / redirects to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("anonymous /meetings/1 redirects to /login, carrying where it was going", async ({ page }) => {
  await page.goto("/meetings/1");
  await expect(page).toHaveURL(/\/login\?next=%2Fmeetings%2F1/);
});

test("anonymous /api/vexa/meetings is a 401, not a redirect", async ({ request }) => {
  const res = await request.get("/api/vexa/meetings", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.error).toBe("not_authenticated");
});
