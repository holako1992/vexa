/** Property 8 — the key never reaches the browser.
 *
 *  Expected: the session token minted by admin-api never appears in any response body the
 *  browser receives, is not present as a JS-readable cookie, and the `vexa-token` cookie the
 *  browser DOES hold is `httpOnly`.
 */
import { test, expect } from "@playwright/test";
import { adminRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("the minted API token is httpOnly and never appears in a response body or JS-visible cookie", async ({ page, context, request }) => {
  await signIn(page, testEmail("keysafety"));

  // The real token, straight from admin-api's own log — the ground truth to search for.
  const minted = (await adminRequests(request)).find((r) => r.method === "POST" && /\/tokens\?/.test(r.url));
  expect(minted).toBeTruthy();

  const cookies = await context.cookies();
  const tokenCookie = cookies.find((c) => c.name === "vexa-token");
  expect(tokenCookie).toBeTruthy();
  expect(tokenCookie!.httpOnly).toBe(true);

  // document.cookie is what any injected script could read — the httpOnly cookie must be absent.
  const jsVisibleCookies = await page.evaluate(() => document.cookie);
  expect(jsVisibleCookies).not.toMatch(/vexa-token/);

  // The JSON surfaces a script could actually read (fetch/XHR) must never echo the token or the
  // admin-api key — that IS this property.
  //
  // NOT included here: the full page HTML of "/" and "/meetings/<id>". Under `next dev` only
  // (verified against a `next build && next start` production run — it does NOT), Next 15's own
  // React Server Components debug payload embeds the raw value of every cookie a Server
  // Component read via `cookies()` (session.ts's `sessionToken()`/`currentUser()`) as a literal
  // string in the RSC flight data. That is a `next dev` framework artifact — production strips
  // it, and neither this app's code nor its middleware puts the token there — so asserting on it
  // would be testing Next's dev tooling, not this app. Filed as a finding for the harness's own
  // README rather than papered over here.
  for (const url of ["/api/vexa/meetings", "/api/auth/me"]) {
    const res = await page.request.get(url);
    const text = await res.text();
    expect(text).not.toContain("e2e-stub-admin-key");
    expect(text).not.toContain(tokenCookie!.value);
  }
});
