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
