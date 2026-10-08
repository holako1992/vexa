/** Delete account: immediate, irreversible, confirmed by typing the account's own email.
 *
 *  Expected: the dialog's Delete button is disabled until the typed email matches (trimmed, any
 *  case); the server checks again and a hand-made request with a wrong or missing email is a 400
 *  that never reaches admin-api. A confirmed delete removes the user, their tokens and their data
 *  at the core, clears this browser's cookies, lands on /login with a plain notice, refuses a
 *  second browser's next request, and signing in again with the same address makes a FRESH, empty
 *  account. A deletion the core leaves partial is said in plain words (never "deleted"), the
 *  server having retried a bounded number of times; a refusal (409) is a fixed sentence, not the
 *  producer's. A body naming another user is ignored. Cross-origin is 403, anonymous 401.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_API_KEY, ADMIN_URL, DASHBOARD_URL, GATEWAY_URL } from "../ports.mjs";
import { adminRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

const KEY = { "X-Admin-API-Key": ADMIN_API_KEY };

async function lookup(request: APIRequestContext, email: string): Promise<{ status: number; id?: number }> {
  const res = await request.get(`${ADMIN_URL}/admin/users/email/${encodeURIComponent(email)}`, { headers: KEY });
  return { status: res.status(), id: res.ok() ? ((await res.json()) as { id: number }).id : undefined };
}

async function adminDeletes(request: APIRequestContext) {
  return (await adminRequests(request)).filter((r) => r.method === "DELETE" && /\/admin\/users\/\d+$/.test(r.url));
}

async function force(request: APIRequestContext, data: Record<string, unknown>) {
  await request.post(`${GATEWAY_URL}/__control/force`, { data });
}

async function openDialog(page: import("@playwright/test").Page) {
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Delete account" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the page says what is erased, and the dialog needs the exact email before Delete is enabled", async ({ page, request }) => {
  const email = testEmail("delete-gate");
  await signIn(page, email);
  await page.goto("/settings/account");
  const section = page.getByRole("region", { name: "Delete account" });
  for (const word of ["meetings", "transcripts", "recordings", "summaries", "calendar", "API keys", "chat history", "no refund", "cannot be undone"]) {
    await expect(section).toContainText(word);
  }

  const dialog = await openDialog(page);
  const del = dialog.getByRole("button", { name: "Delete my account" });
  await expect(del).toBeDisabled();
  const input = dialog.getByLabel("Your email address");
  await input.fill("someone-else@e2e.test");
  await expect(del).toBeDisabled();
  await input.fill(email.slice(0, -1));
  await expect(del).toBeDisabled();
  await input.fill(`  ${email.toUpperCase()} `);
  await expect(del).toBeEnabled();

  // Cancel sends nothing and the account is untouched.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await adminDeletes(request)).toHaveLength(0);
  expect((await lookup(request, email)).status).toBe(200);
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
});

test("the server re-checks the email: a hand-made wrong or missing confirmation is a 400 and never reaches admin-api", async ({ page, request }) => {
  const email = testEmail("delete-server-check");
  await signIn(page, email);
  // Three attempts is the whole allowance (the limiter is its own test below).
  for (const data of [{ confirmEmail: "other@e2e.test" }, {}, { confirmEmail: 7 }]) {
    const res = await page.request.delete("/api/account", { data });
    expect(res.status()).toBe(400);
  }
  expect(await adminDeletes(request)).toHaveLength(0);
  expect((await lookup(request, email)).status).toBe(200);
});

test("a confirmed delete erases the account, signs everyone out, and the same address starts fresh", async ({ page, browser, request }) => {
  const email = testEmail("delete-ok");
  await signIn(page, email);
  const { id } = await lookup(request, email);
  const other = await browser.newContext({ baseURL: DASHBOARD_URL });
  const otherPage = await other.newPage();
  await signIn(otherPage, email);
  expect((await other.request.get("/api/vexa/meetings")).status()).toBe(200);
  const before = (await (await page.request.get("/api/vexa/meetings")).json()) as { meetings?: unknown[] } | unknown[];
  expect((Array.isArray(before) ? before : before.meetings ?? []).length).toBeGreaterThan(0);

  const dialog = await openDialog(page);
  await dialog.getByLabel("Your email address").fill(email);
  await dialog.getByRole("button", { name: "Delete my account" }).click();

  await expect(page).toHaveURL(/\/login\?notice=account-deleted$/);
  await expect(page.getByRole("status")).toContainText("deleted");
  const names = (await page.context().cookies()).map((c) => c.name);
  expect(names).not.toContain("vexa-token");
  expect(names).not.toContain("vexa-user-info");

  // The core side: exactly one erase call, for the oracle's user; the user is gone.
  const deletes = await adminDeletes(request);
  expect(deletes.map((d) => d.url)).toEqual([`/admin/users/${id}`]);
  expect((await lookup(request, email)).status).toBe(404);

  // The second browser is refused everywhere.
  expect((await other.request.get("/api/auth/me")).status()).toBe(401);
  expect((await other.request.get("/api/vexa/meetings")).status()).toBe(401);
  await otherPage.goto("/");
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();

  // Signing in again with the same address is a new account with nothing in it.
  await signIn(page, email);
  const fresh = await lookup(request, email);
  expect(fresh.status).toBe(200);
  expect(fresh.id).not.toBe(id);
  const after = (await (await page.request.get("/api/vexa/meetings")).json()) as { meetings?: unknown[] } | unknown[];
  expect(Array.isArray(after) ? after : after.meetings ?? []).toHaveLength(0);
  const acct = (await (await page.request.get("/api/account")).json()) as { email: string; sessions: unknown[] };
  expect(acct.email).toBe(email);
  expect(acct.sessions).toHaveLength(1);
});

test("a deletion the core leaves partial is said in plain words, never as deleted, after a bounded number of tries", async ({ page, request }) => {
  const email = testEmail("delete-partial");
  await signIn(page, email);
  await force(request, { userDelete: "partial" });

  const dialog = await openDialog(page);
  await dialog.getByLabel("Your email address").fill(email);
  await dialog.getByRole("button", { name: "Delete my account" }).click();

  const partial = page.getByTestId("delete-partial");
  await expect(partial).toContainText("part of it didn't finish");
  await expect(partial).toContainText("Sign-in is blocked");
  await expect(partial).toContainText("support");
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByText(/has been deleted/)).toHaveCount(0);

  expect(await adminDeletes(request)).toHaveLength(3);
  // The session was already revoked by the core: the cookie is cleared and the API says so.
  expect((await page.context().cookies()).map((c) => c.name)).not.toContain("vexa-token");
  expect((await page.request.get("/api/account")).status()).toBe(401);
  // The account still exists at the core, locked, for an operator to finish.
  expect((await lookup(request, email)).status).toBe(200);

  await page.getByRole("button", { name: "Go to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("a partial that the retry finishes is a success", async ({ page, request }) => {
  const email = testEmail("delete-resume");
  await signIn(page, email);
  await force(request, { userDeletePartialFirst: 1 });

  const dialog = await openDialog(page);
  await dialog.getByLabel("Your email address").fill(email);
  await dialog.getByRole("button", { name: "Delete my account" }).click();

  await expect(page).toHaveURL(/\/login\?notice=account-deleted$/);
  expect(await adminDeletes(request)).toHaveLength(2);
  expect((await lookup(request, email)).status).toBe(404);
});

test("a refusal is a fixed sentence, not the producer's, and changes nothing", async ({ page, request }) => {
  const email = testEmail("delete-conflict");
  await signIn(page, email);
  await force(request, { userDelete: "conflict" });

  const dialog = await openDialog(page);
  await dialog.getByLabel("Your email address").fill(email);
  await dialog.getByRole("button", { name: "Delete my account" }).click();

  await expect(dialog.getByText("Your account can't be deleted right now. Nothing was changed.")).toBeVisible();
  await expect(page.getByText(/raw producer sentence/)).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/account$/);
  expect(await adminDeletes(request)).toHaveLength(1);
  expect((await page.context().cookies()).map((c) => c.name)).toContain("vexa-token");
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  expect((await lookup(request, email)).status).toBe(200);
});

test("the deployment's only administrator is told why, in fixed words, and nothing changes", async ({ page, request }) => {
  const email = testEmail("delete-last-admin");
  await signIn(page, email);
  await force(request, { userDelete: "last_admin" });

  const dialog = await openDialog(page);
  await dialog.getByLabel("Your email address").fill(email);
  await dialog.getByRole("button", { name: "Delete my account" }).click();

  await expect(dialog.getByText("This is the only administrator account on this deployment")).toBeVisible();
  await expect(page.getByText(/raw producer sentence/)).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/account$/);
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  expect((await lookup(request, email)).status).toBe(200);
});

test("a body, query or path naming another user is ignored: that user survives", async ({ page, browser, request }) => {
  const mine = testEmail("delete-mine");
  const theirs = testEmail("delete-theirs");
  const victim = await browser.newContext({ baseURL: DASHBOARD_URL });
  const victimPage = await victim.newPage();
  await signIn(victimPage, theirs);
  await signIn(page, mine);
  const theirId = (await lookup(request, theirs)).id;
  const myId = (await lookup(request, mine)).id;

  // Naming the victim, and confirming with the victim's address, is not my confirmation.
  const refused = await page.request.delete(`/api/account?userId=${theirId}`, { data: { userId: theirId, user_id: theirId, confirmEmail: theirs } });
  expect(refused.status()).toBe(400);
  expect((await page.request.delete(`/api/account/${theirId}`, { data: { confirmEmail: mine } })).status()).toBe(404);
  expect(await adminDeletes(request)).toHaveLength(0);

  // With my own address the oracle's user is the one erased, whatever else the request says.
  const ok = await page.request.delete(`/api/account?userId=${theirId}`, { data: { userId: theirId, user_id: theirId, confirmEmail: mine } });
  expect(ok.status()).toBe(200);
  expect((await adminDeletes(request)).map((d) => d.url)).toEqual([`/admin/users/${myId}`]);
  expect((await lookup(request, theirs)).status).toBe(200);
  expect((await victim.request.get("/api/auth/me")).status()).toBe(200);
  await victim.close();
});

test("cross-origin is 403, anonymous is 401, and neither reaches admin-api", async ({ page, playwright, request }) => {
  const email = testEmail("delete-guards");
  await signIn(page, email);
  const cross = await page.request.delete("/api/account", { headers: { Origin: "https://evil.example" }, data: { confirmEmail: email } });
  expect(cross.status()).toBe(403);
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);

  const anon = await playwright.request.newContext({ baseURL: DASHBOARD_URL });
  expect((await anon.delete("/api/account", { data: { confirmEmail: email } })).status()).toBe(401);
  await anon.dispose();
  expect(await adminDeletes(request)).toHaveLength(0);
  expect((await lookup(request, email)).status).toBe(200);
});

test("repeated guesses are rate limited before they reach admin-api", async ({ page, request }) => {
  await signIn(page, testEmail("delete-limit"));
  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await page.request.delete("/api/account", { data: { confirmEmail: "nope@e2e.test" } })).status());
  expect(statuses).toEqual([400, 400, 400, 429, 429]);
  expect(await adminDeletes(request)).toHaveLength(0);
});

test("the dialog fits 375x812 and is operable from the keyboard", async ({ page }) => {
  const email = testEmail("delete-mobile");
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, email);
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Delete account" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Your email address")).toBeFocused();
  await page.keyboard.type(email);
  await expect(dialog.getByRole("button", { name: "Delete my account" })).toBeEnabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete account" })).toBeFocused();
});
