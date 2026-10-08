/** The account page: profile, recorded sign-in door, active sessions, "sign out everywhere".
 *
 *  Expected: /settings/account shows the signed-in person's own email, initials, the sign-in door
 *  admin-api recorded and one session per `dashboard-login` token. Confirming "Sign out
 *  everywhere" revokes every `dashboard-login` token (a second browser's next request is a 401 and
 *  its next page load is /login), keeps tokens the person made for themselves, clears this
 *  browser's cookies and lands on /login with a plain notice. A failing revoke is said in plain
 *  words and leaves this browser signed in. Nothing in a request can aim the page at another user.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_API_KEY, ADMIN_URL, DASHBOARD_URL, GATEWAY_URL } from "../ports.mjs";
import { adminRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

interface TokenRow { id: number; name: string | null; user_id: number }

async function tokensOf(request: import("@playwright/test").APIRequestContext, userId: number): Promise<TokenRow[]> {
  const res = await request.get(`${ADMIN_URL}/admin/users/${userId}/tokens`, { headers: { "X-Admin-API-Key": ADMIN_API_KEY } });
  return (await res.json()) as TokenRow[];
}

async function userId(request: import("@playwright/test").APIRequestContext, email: string): Promise<number> {
  const res = await request.get(`${ADMIN_URL}/admin/users/email/${encodeURIComponent(email)}`, { headers: { "X-Admin-API-Key": ADMIN_API_KEY } });
  return ((await res.json()) as { id: number }).id;
}

test("profile, sign-in method and sessions render for the signed-in person", async ({ page }) => {
  const email = testEmail("account-view");
  await signIn(page, email);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();

  await expect(page.getByTestId("account-email")).toHaveText(email);
  await expect(page.getByTestId("avatar-initials")).toHaveText("AV");
  await expect(page.getByTestId("account-provider")).toHaveText("Email address");
  await expect(page.getByTestId("account-provider-detail")).toHaveText("Email address not verified");
  await expect(page.getByTestId("session-list").getByRole("listitem")).toHaveCount(1);
});

test("sign out everywhere revokes every dashboard-login token, spares the person's own keys, and signs this browser out", async ({ page, browser, request }) => {
  const email = testEmail("account-signout");
  await signIn(page, email);
  const id = await userId(request, email);

  // A second browser, signed in as the same person, and a key the person made for themselves.
  const other = await browser.newContext({ baseURL: DASHBOARD_URL });
  const otherPage = await other.newPage();
  await signIn(otherPage, email);
  await request.post(`${ADMIN_URL}/admin/users/${id}/tokens?scopes=bot&name=my-ci-key`, { headers: { "X-Admin-API-Key": ADMIN_API_KEY } });
  expect((await tokensOf(request, id)).map((t) => t.name).sort()).toEqual(["dashboard-login", "dashboard-login", "my-ci-key"]);
  expect((await other.request.get("/api/auth/me")).status()).toBe(200);
  expect((await other.request.get("/api/vexa/meetings")).status()).toBe(200);

  await page.goto("/settings/account");
  await expect(page.getByTestId("session-list").getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sign out everywhere" }).click();

  await expect(page).toHaveURL(/\/login\?notice=signed-out-everywhere$/);
  await expect(page.getByRole("status")).toContainText("signed out on every device");
  const names = (await page.context().cookies()).map((c) => c.name);
  expect(names).not.toContain("vexa-token");
  expect(names).not.toContain("vexa-user-info");

  // The core side: only the self-made key is left.
  expect((await tokensOf(request, id)).map((t) => t.name)).toEqual(["my-ci-key"]);

  // The second browser: its very next requests are refused, and its next page is /login.
  expect((await other.request.get("/api/auth/me")).status()).toBe(401);
  expect((await other.request.get("/api/vexa/meetings")).status()).toBe(401);
  expect((await other.request.get("/api/account")).status()).toBe(401);
  await otherPage.goto("/");
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();
});

test("cancelling the confirmation changes nothing", async ({ page, request }) => {
  const email = testEmail("account-cancel");
  await signIn(page, email);
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.getByRole("dialog", { name: "Sign out everywhere?" }).getByRole("button", { name: "Stay signed in" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await adminRequests(request)).filter((r) => r.method === "DELETE")).toHaveLength(0);
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
});

test("a refused revoke is said in plain words and leaves this browser signed in", async ({ page, request }) => {
  const email = testEmail("account-refused");
  await signIn(page, email);
  await page.goto("/settings/account");
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { tokenDelete: 500 } });

  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.getByRole("dialog", { name: "Sign out everywhere?" }).getByRole("button", { name: "Sign out everywhere" }).click();

  await expect(page.getByText("Couldn't sign out everywhere")).toBeVisible();
  await expect(page.getByText(/Some sessions could not be signed out|backend is unreachable/)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/account$/);
  expect((await page.context().cookies()).map((c) => c.name)).toContain("vexa-token");
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
});

test("nothing in a request can aim the page at another user", async ({ page, browser, request }) => {
  const mine = testEmail("account-mine");
  const theirs = testEmail("account-theirs");
  const victim = await browser.newContext({ baseURL: DASHBOARD_URL });
  const victimPage = await victim.newPage();
  await signIn(victimPage, theirs);
  await signIn(page, mine);
  const myId = await userId(request, mine);
  const theirId = await userId(request, theirs);
  expect(theirId).not.toBe(myId);

  // Body, query and path all name the other user; none of it is read.
  const read = await page.request.get(`/api/account?userId=${theirId}&user_id=${theirId}`);
  expect(read.status()).toBe(200);
  expect((await read.json()).email).toBe(mine);
  expect((await page.request.delete(`/api/account/sessions/${theirId}`)).status()).toBe(404);
  const del = await page.request.delete(`/api/account/sessions?userId=${theirId}`, { data: { userId: theirId, user_id: theirId, email: theirs } });
  expect(del.status()).toBe(200);

  expect((await tokensOf(request, theirId)).map((t) => t.name)).toEqual(["dashboard-login"]);
  expect(await tokensOf(request, myId)).toEqual([]);
  expect((await victim.request.get("/api/auth/me")).status()).toBe(200);

  // The account routes never read or wrote the other user's record (their sign-in's own mint and
  // prune calls are the only `/tokens` traffic that names them).
  const accountCalls = (await adminRequests(request)).filter((r) => r.url.includes(`/admin/users/${theirId}`) && r.method !== "POST" && !r.url.includes("/tokens"));
  expect(accountCalls).toHaveLength(0);
  await victim.close();
});

test("the sign-out route refuses a cross-origin write and an unauthenticated caller", async ({ page, playwright, request }) => {
  await signIn(page, testEmail("account-guards"));
  const cross = await page.request.delete("/api/account/sessions", { headers: { Origin: "https://evil.example" } });
  expect(cross.status()).toBe(403);
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);

  const anon = await playwright.request.newContext({ baseURL: DASHBOARD_URL });
  expect((await anon.get("/api/account")).status()).toBe(401);
  expect((await anon.delete("/api/account/sessions")).status()).toBe(401);
  await anon.dispose();
  expect((await adminRequests(request)).filter((r) => r.method === "DELETE")).toHaveLength(0);
});

test("a live session is bounced off /login, a revoked one is shown the form", async ({ page, request }) => {
  const email = testEmail("account-login-bounce");
  await signIn(page, email);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/$/);

  const id = await userId(request, email);
  for (const t of await tokensOf(request, id)) {
    await request.delete(`${ADMIN_URL}/admin/tokens/${t.id}`, { headers: { "X-Admin-API-Key": ADMIN_API_KEY } });
  }
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Vexa" })).toBeVisible();
  await page.goto("/billing");
  await expect(page).toHaveURL(/\/login/);
});

test("the account page has no horizontal scroll at 375x812", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, testEmail("account-mobile"));
  await page.goto("/settings/account");
  await expect(page.getByTestId("account-email")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
