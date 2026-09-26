/** Property 6 — connecting a calendar.
 *
 *  ICS half (unchanged by DB-31): add an ICS connection (`POST /user/calendars`), then toggle
 *  auto-join (`PATCH /user/calendars/<id>`).
 *
 *  DB-31 half — Google Calendar is now the PRIMARY path, no text entry at all:
 *   - `GET /user/calendars/google/authorize` → the dashboard's own `isTrustedGoogleAuthorizeRedirect`
 *     check → a real full-page navigation to `accounts.google.com`, intercepted here with
 *     `page.route` and redirected straight back to `/calendar/google/callback?code=…&state=…` —
 *     the same "never actually leave the test environment" pattern spec 17 uses for Stripe.
 *   - The callback page relays `{code, state}` to `POST …/exchange`; on success it hands the
 *     browser back to `/?calendar=connected`, which reopens the SAME dialog on the Calendar tab
 *     and toasts success.
 *   - Denied consent (`error=access_denied`), a state the stub never issued (mismatch/forged),
 *     and the stub forcing the exchange call itself to fail each show THAT producer's own
 *     message, verbatim, on the callback page — never a generic "something went wrong".
 *   - A connection already carrying `reconnect_needed: true` shows a **Reconnect** action that
 *     re-runs the exact same flow and clears the flag on success.
 */
import { test, expect } from "@playwright/test";
import { DASHBOARD_URL } from "../ports.mjs";
import { E2E_GOOGLE_EMAIL } from "../fixtures.mjs";
import { forceGoogleExchange, gatewayRequests, resetStub, seedCalendar, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

/** Installs the one intercept every Google-flow spec below needs: a full-page navigation to
 *  `accounts.google.com` is fulfilled with a 302 straight back to the dashboard's own callback
 *  page, carrying whatever query string `buildQuery` derives from the REAL `state` Google's own
 *  redirect would have echoed back (read here off the intercepted request's own `state` param,
 *  never invented by the test) — so a spec can prove the state-mismatch and consent-denied paths
 *  without ever reaching a real Google server. */
async function interceptGoogleConsent(
  page: import("@playwright/test").Page,
  buildQuery: (issuedState: string) => Record<string, string>,
) {
  await page.route("https://accounts.google.com/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const issuedState = requestUrl.searchParams.get("state") ?? "";
    const query = new URLSearchParams(buildQuery(issuedState)).toString();
    await route.fulfill({
      status: 302,
      headers: { location: `${DASHBOARD_URL}/calendar/google/callback?${query}` },
    });
  });
}

test("connect an ICS calendar, then toggle auto-join", async ({ page, request }) => {
  await signIn(page, testEmail("calendar"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();

  await page.getByRole("button", { name: "Connect a calendar" }).click();
  await page.getByLabel("Name").fill("Work calendar");
  await page.getByLabel("Secret ICS address").fill("https://calendar.example.com/secret/basic.ics");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByText("Work calendar")).toBeVisible();

  const afterConnect = await gatewayRequests(request);
  const connectCall = afterConnect.find((r) => r.method === "POST" && r.url === "/user/calendars");
  expect(connectCall).toBeTruthy();

  // Expand the row, then flip auto-join.
  await page.getByRole("button", { name: "Expand" }).click();
  await expect(page.getByText("Auto-join meetings from this calendar")).toBeVisible();
  // DB-04: auto-join is a real `Toggle` (`role="switch"`) now, not a `<span role="checkbox">` —
  // the control's accessible role changed on purpose, so the locator follows it.
  await page.getByRole("switch").click();

  await expect
    .poll(async () => {
      const reqs = await gatewayRequests(request);
      return reqs.some((r) => r.method === "PATCH" && /^\/user\/calendars\/\d+$/.test(r.url));
    })
    .toBe(true);
});

test("connect a Google calendar with no text entry at all", async ({ page, request }) => {
  await signIn(page, testEmail("calendar-google-connect"));
  await interceptGoogleConsent(page, (issuedState) => ({ code: "e2e-test-code", state: issuedState }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();

  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Google Calendar connected" })).toBeVisible();
  await expect(page.getByText(E2E_GOOGLE_EMAIL)).toBeVisible();

  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");

  // Back on the SAME dialog, the Calendar tab, with a success toast — never a bare navigation.
  await expect(page.getByRole("status").filter({ hasText: "Google Calendar connected." })).toBeVisible();
  await expect(page.getByText(E2E_GOOGLE_EMAIL).first()).toBeVisible();
  await expect(page.getByText("Reconnect needed")).toHaveCount(0);

  const exchangeCall = (await gatewayRequests(request)).find(
    (r) => r.method === "POST" && r.url === "/user/calendars/google/exchange",
  );
  expect(exchangeCall).toBeTruthy();
});

test("denied consent (error=access_denied) shows the exact reason, never a generic error", async ({ page }) => {
  await signIn(page, testEmail("calendar-google-denied"));
  await interceptGoogleConsent(page, () => ({ error: "access_denied" }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();

  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Couldn't connect Google Calendar" })).toBeVisible();
  await expect(page.locator('p[role="alert"]')).toHaveText(/declined Google's consent screen/);

  // The way back is right there — never a dead end.
  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");
  await expect(page.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
});

test("a state the stub never issued is refused with the core's own message, verbatim", async ({ page }) => {
  await signIn(page, testEmail("calendar-google-state-mismatch"));
  // A forged/expired state — never one the stub's authorize call actually issued.
  // Shaped like a real signed state (two dot-separated segments — the dashboard's own allowlist
  // requires that shape before it will even forward the request) but never one the stub issued.
  await interceptGoogleConsent(page, () => ({ code: "e2e-test-code", state: "forgedstate12345.notissuedvalue1" }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();

  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Couldn't connect Google Calendar" })).toBeVisible();
  // The producer's exact detail (admin-api's `HTTPException(400, detail=f"invalid state: {e}")`
  // shape), not a squashed generic message.
  await expect(page.locator('p[role="alert"]')).toHaveText(/^invalid state: /);
});

test("the exchange call itself failing shows THAT failure, not a generic error", async ({ page, request }) => {
  await signIn(page, testEmail("calendar-google-exchange-fails"));
  await forceGoogleExchange(request, 502);
  await interceptGoogleConsent(page, (issuedState) => ({ code: "e2e-test-code", state: issuedState }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Google Calendar" }).click();

  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Couldn't connect Google Calendar" })).toBeVisible();
  await expect(page.locator('p[role="alert"]')).toHaveText(/Google rejected the authorization code: invalid_grant/);
});

test("a connection needing reconnect shows Reconnect, and re-running the flow clears it", async ({ page, request }) => {
  await signIn(page, testEmail("calendar-google-reconnect"));
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
  await interceptGoogleConsent(page, (issuedState) => ({ code: "e2e-test-code", state: issuedState }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();

  await expect(page.getByText("Reconnect needed")).toBeVisible();
  await page.getByRole("button", { name: "Reconnect" }).click();

  await page.waitForURL(/\/calendar\/google\/callback/);
  await expect(page.getByRole("heading", { name: "Google Calendar connected" })).toBeVisible();
  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");

  await expect(page.getByText("Reconnect needed")).toHaveCount(0);
  const exchangeCalls = (await gatewayRequests(request)).filter(
    (r) => r.method === "POST" && r.url === "/user/calendars/google/exchange",
  );
  expect(exchangeCalls.length).toBe(1);
});
