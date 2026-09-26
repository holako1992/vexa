/** DB-32/DB-33 — Connect Microsoft 365, the Google connect flow's sibling.
 *
 *  Same properties `06-calendar.spec.ts` proves for Google, against
 *  `login.microsoftonline.com` instead of `accounts.google.com`, and `/calendar/microsoft/
 *  callback` instead of `/calendar/google/callback`:
 *   - `GET /user/calendars/microsoft/authorize` → the dashboard's own
 *     `isTrustedMicrosoftAuthorizeRedirect` check → a real full-page navigation to
 *     `login.microsoftonline.com`, intercepted here with `page.route` and redirected straight
 *     back to the dashboard's own callback page — never actually leaving the test environment.
 *   - The callback page relays `{code, state}` to `POST …/exchange`; on success it hands the
 *     browser back to `/?calendar=connected`.
 *   - Denied consent, a forged/unissued state, and the exchange call itself failing each show
 *     THAT producer's own message, verbatim.
 *   - A connection already carrying `reconnect_needed: true` shows Reconnect, and re-running the
 *     flow clears it — same as Google's, on the SAME connection kind's flag
 *     (`calendars.py`'s `set_reconnect_needed` treats `"google"`/`"microsoft"` identically).
 */
import { test, expect } from "@playwright/test";
import { DASHBOARD_URL } from "../ports.mjs";
import { E2E_MICROSOFT_EMAIL } from "../fixtures.mjs";
import { forceMicrosoftExchange, gatewayRequests, resetStub, seedCalendar, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

/** Installs the intercept every Microsoft-flow spec below needs: a full-page navigation to
 *  `login.microsoftonline.com` is fulfilled with a 302 straight back to the dashboard's own
 *  callback page, carrying whatever query string `buildQuery` derives from the REAL `state`
 *  Microsoft's own redirect would have echoed back. */
async function interceptMicrosoftConsent(
  page: import("@playwright/test").Page,
  buildQuery: (issuedState: string) => Record<string, string>,
) {
  await page.route("https://login.microsoftonline.com/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const issuedState = requestUrl.searchParams.get("state") ?? "";
    const query = new URLSearchParams(buildQuery(issuedState)).toString();
    await route.fulfill({
      status: 302,
      headers: { location: `${DASHBOARD_URL}/calendar/microsoft/callback?${query}` },
    });
  });
}

test("connect a Microsoft 365 calendar with no text entry at all", async ({ page, request }) => {
  await signIn(page, testEmail("calendar-microsoft-connect"));
  await interceptMicrosoftConsent(page, (issuedState) => ({ code: "e2e-test-code", state: issuedState }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Microsoft 365" }).click();

  await page.waitForURL(/\/calendar\/microsoft\/callback/);
  await expect(page.getByRole("heading", { name: "Microsoft 365 connected" })).toBeVisible();
  await expect(page.getByText(E2E_MICROSOFT_EMAIL)).toBeVisible();

  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");

  await expect(page.getByRole("status").filter({ hasText: "Microsoft 365 connected." })).toBeVisible();
  await expect(page.getByText(E2E_MICROSOFT_EMAIL).first()).toBeVisible();
  await expect(page.getByText("Reconnect needed")).toHaveCount(0);

  const exchangeCall = (await gatewayRequests(request)).find(
    (r) => r.method === "POST" && r.url === "/user/calendars/microsoft/exchange",
  );
  expect(exchangeCall).toBeTruthy();
});

test("denied consent shows the exact reason, never a generic error", async ({ page }) => {
  await signIn(page, testEmail("calendar-microsoft-denied"));
  await interceptMicrosoftConsent(page, () => ({ error: "access_denied" }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Microsoft 365" }).click();

  await page.waitForURL(/\/calendar\/microsoft\/callback/);
  await expect(page.getByRole("heading", { name: "Couldn't connect Microsoft 365" })).toBeVisible();
  await expect(page.locator('p[role="alert"]')).toHaveText(/declined Microsoft's consent screen/);

  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");
  await expect(page.getByRole("button", { name: "Connect Microsoft 365" })).toBeVisible();
});

test("a state the stub never issued is refused with the core's own message, verbatim", async ({ page }) => {
  await signIn(page, testEmail("calendar-microsoft-state-mismatch"));
  await interceptMicrosoftConsent(page, () => ({ code: "e2e-test-code", state: "forgedstate12345.notissuedvalue1" }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Microsoft 365" }).click();

  await page.waitForURL(/\/calendar\/microsoft\/callback/);
  await expect(page.getByRole("heading", { name: "Couldn't connect Microsoft 365" })).toBeVisible();
  await expect(page.locator('p[role="alert"]')).toHaveText(/^invalid state: /);
});

test("the exchange call itself failing shows THAT failure, not a generic error", async ({ page, request }) => {
  await signIn(page, testEmail("calendar-microsoft-exchange-fails"));
  await forceMicrosoftExchange(request, 502);
  await interceptMicrosoftConsent(page, (issuedState) => ({ code: "e2e-test-code", state: issuedState }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Microsoft 365" }).click();

  await page.waitForURL(/\/calendar\/microsoft\/callback/);
  await expect(page.getByRole("heading", { name: "Couldn't connect Microsoft 365" })).toBeVisible();
  await expect(page.locator('p[role="alert"]')).toHaveText(/Microsoft rejected the authorization code: invalid_grant/);
});

test("a connection needing reconnect shows Reconnect, and re-running the flow clears it", async ({ page, request }) => {
  await signIn(page, testEmail("calendar-microsoft-reconnect"));
  await seedCalendar(request, {
    kind: "microsoft",
    name: `Microsoft — ${E2E_MICROSOFT_EMAIL}`,
    microsoft_email: E2E_MICROSOFT_EMAIL,
    microsoft_calendar_ids: ["primary"],
    reconnect_needed: true,
    auto_join: true,
    bot_name: "Vexa",
    enabled: true,
  });
  await interceptMicrosoftConsent(page, (issuedState) => ({ code: "e2e-test-code", state: issuedState }));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();

  await expect(page.getByText("Reconnect needed")).toBeVisible();
  await page.getByRole("button", { name: "Reconnect" }).click();

  await page.waitForURL(/\/calendar\/microsoft\/callback/);
  await expect(page.getByRole("heading", { name: "Microsoft 365 connected" })).toBeVisible();
  await page.getByRole("button", { name: "Back to Calendar" }).click();
  await page.waitForURL("**/");

  await expect(page.getByText("Reconnect needed")).toHaveCount(0);
  const exchangeCalls = (await gatewayRequests(request)).filter(
    (r) => r.method === "POST" && r.url === "/user/calendars/microsoft/exchange",
  );
  expect(exchangeCalls.length).toBe(1);
});

test("clicking Connect Microsoft 365 never disables Connect Google Calendar, and vice versa", async ({ page }) => {
  // Never actually resolve the Microsoft authorize call — proves the OTHER button's state
  // independent of this one being in flight, without needing a full navigation.
  await page.route("**/api/vexa/user/calendars/microsoft/authorize", async () => {
    await new Promise(() => {}); // never resolves within the test's lifetime
  });
  await signIn(page, testEmail("calendar-microsoft-independent-busy"));

  await page.getByRole("button", { name: "Add Bot" }).click();
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Connect Microsoft 365" }).click();

  await expect(page.getByRole("button", { name: /opening microsoft/i })).toBeVisible();
  const google = page.getByRole("button", { name: "Connect Google Calendar" });
  await expect(google).toBeEnabled();
});
