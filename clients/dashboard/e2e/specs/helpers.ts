/** Shared plumbing for every spec in this directory — signing in through the real email door and
 *  talking to the stub's `/__control/*` remote control. Kept out of individual spec files so a
 *  spec's body is only the property it is proving, not the mechanics of getting there. */
import type { APIRequestContext, Page } from "@playwright/test";
import { ADMIN_URL, GATEWAY_URL } from "../ports.mjs";

/** An address the stub's admin-api will find-or-create, matching `DASHBOARD_EMAIL_LOGIN_PATTERN`
 *  from `playwright.config.ts`. A fresh one per spec file keeps each spec's user (and its own
 *  `dashboard-login` token) independent of the others. */
export function testEmail(tag: string): string {
  return `${tag}@e2e.test`;
}

/** Reset the stub's ENTIRE world (meetings, calendars, bots, users, tokens, both request logs,
 *  forced-failure overrides) back to the fixtures. One call is enough — both listeners share one
 *  in-process state, so resetting through the gateway resets admin-api too. Call this in every
 *  spec's `beforeEach`; specs never rely on another spec's leftover state or ordering. */
export async function resetStub(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/reset`);
  if (!res.ok()) throw new Error(`stub reset failed: ${res.status()}`);
}

export interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  at: number;
  /** The parsed JSON body the stub GATEWAY received on this request, for every write route that
   *  goes through `handleGateway`'s own `readAndLogBody` (every write route added since DB-33) —
   *  `undefined` on a route that predates it or on a GET. Lets a spec assert the exact payload
   *  that reached the stub, not just that the route was called. */
  body?: unknown;
}

/** Every request the stub GATEWAY has seen since the last reset. */
export async function gatewayRequests(request: APIRequestContext): Promise<LoggedRequest[]> {
  return (await (await request.get(`${GATEWAY_URL}/__control/requests`)).json()) as LoggedRequest[];
}

/** Every request the stub ADMIN-API has seen since the last reset. */
export async function adminRequests(request: APIRequestContext): Promise<LoggedRequest[]> {
  return (await (await request.get(`${ADMIN_URL}/__control/requests`)).json()) as LoggedRequest[];
}

/** Every `POST /bots` body the stub gateway has received since the last reset. */
export async function dispatchedBots(request: APIRequestContext): Promise<Record<string, unknown>[]> {
  return (await (await request.get(`${GATEWAY_URL}/__control/bots`)).json()) as Record<string, unknown>[];
}

/** Force the stub gateway's next `GET /meetings` (and every one after, until the next reset) to
 *  answer with `status` instead of the fixture — spec 09's "failure is not emptiness". */
export async function forceMeetingsList(request: APIRequestContext, status: number): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { meetings: status } });
}

/** Same, for `GET /meetings/<id>`. */
export async function forceMeetingDetail(request: APIRequestContext, status: number): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { meetingDetail: status } });
}

/** Same, for `GET /transcripts/search` — DB-44's error-state spec. */
export async function forceSearch(request: APIRequestContext, status: number): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { search: status } });
}

/** Hold every `GET /transcripts/search` answer until `releaseSearch` (or the next reset), so the
 *  in-flight state is observable without racing the response. */
export async function holdSearch(request: APIRequestContext): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/searchHold`);
}

export async function releaseSearch(request: APIRequestContext): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/searchRelease`);
}

/** Flip one fixture meeting's status directly (DB-48's "a live row on a later page stays visible"
 *  spec) — a shortcut around a real bot lifecycle, which is already covered by 05/13's specs. */
export async function setMeetingStatus(request: APIRequestContext, id: number, status: string): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/setMeetingStatus`, { data: { id, status } });
  if (!res.ok()) throw new Error(`stub set-meeting-status failed: ${res.status()}`);
}

/** Swap the stub's `GET /user/entitlements` answer (DB-74/DB-75) — see `../fixtures.mjs` for the
 *  named states (`freeEntitlements`, `proUnlimitedEntitlements`, `pastDueEntitlements`,
 *  `unknownUsageEntitlements`). Persists until the next `resetStub`. */
export async function setEntitlements(request: APIRequestContext, data: unknown): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/entitlements`, { data });
  if (!res.ok()) throw new Error(`stub set-entitlements failed: ${res.status()}`);
}

/** Make the stub's `POST /bots` answer DB-72's unwrapped 402 `quota_exceeded` body
 *  (`../fixtures.mjs`'s `QUOTA_EXCEEDED_BODY`) instead of dispatching — spec 14's paywall proof. */
export async function forceBotsQuotaExceeded(request: APIRequestContext, on = true): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { botsQuota: on } });
}

/** Force the stub gateway's next `POST /user/calendars/google/exchange` (and every one after,
 *  until the next reset) to answer `status` instead of resolving state normally — DB-31's
 *  exchange-failure spec (Google itself rejecting the code, surfaced verbatim). */
export async function forceGoogleExchange(request: APIRequestContext, status: number | null): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { googleExchange: status } });
}

/** The Microsoft sibling of `forceGoogleExchange` above — DB-32/DB-33's exchange-failure spec. */
export async function forceMicrosoftExchange(request: APIRequestContext, status: number | null): Promise<void> {
  await request.post(`${GATEWAY_URL}/__control/force`, { data: { microsoftExchange: status } });
}

/** Seed one connection's sync stamp directly (`{last_sync, last_error, counts}` — the exact
 *  shape `GET /user/calendars/<id>/sync` answers) — DB-34's health-page specs prove a failed
 *  feed and an event count without driving a real sync first. */
export async function seedSyncStamp(
  request: APIRequestContext,
  calendarId: string,
  stamp: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/seedSyncStamp`, { data: { calendarId, stamp } });
  if (!res.ok()) throw new Error(`stub seed-sync-stamp failed: ${res.status()}`);
}

/** Push one raw calendar connection straight into the stub's list — DB-31's reconnect spec seeds
 *  an existing Google connection with `reconnect_needed: true` this way, without driving a real
 *  connect first. An `id` is minted if the caller doesn't supply one. */
export async function seedCalendar(request: APIRequestContext, calendar: Record<string, unknown>): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/seedCalendar`, { data: calendar });
  if (!res.ok()) throw new Error(`stub seed-calendar failed: ${res.status()}`);
}

/** Set or clear whether the stub's account has a Stripe customer on file (DB-74b) — governs
 *  whether `POST /billing/portal` answers a session or a 409. `POST /billing/checkout` sets this
 *  itself on first use, same as the real core; call this to reach the portal's success path
 *  directly, without driving a checkout first. */
export async function setStripeCustomer(request: APIRequestContext, present: boolean): Promise<void> {
  const res = await request.post(`${GATEWAY_URL}/__control/billingCustomer`, { data: { present } });
  if (!res.ok()) throw new Error(`stub set-stripe-customer failed: ${res.status()}`);
}

/** One counter for the whole run — each call gets its own fake source IP, so the login route's
 *  rate limiter (5 attempts / 10 minutes per client, `lib/rateLimit.ts`) sees every spec's
 *  sign-in as a different client instead of exhausting one shared "direct" bucket. Requires
 *  `DASHBOARD_TRUST_PROXY=true` (set in `playwright.config.ts`) for X-Forwarded-For to count. */
let signInCounter = 0;

/** Drive the real email-login form to a signed-in state and land on the meetings list. Uses the
 *  UI, not a cookie shortcut — DB-02 exists to prove the actual sign-in flow, not to route around
 *  it. */
export async function signIn(page: Page, email: string): Promise<void> {
  signInCounter += 1;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.99.0.${signInCounter % 250}` });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/");
  await page.getByRole("heading", { name: "Meetings" }).waitFor();
}
