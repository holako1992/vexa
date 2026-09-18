/** Property 7 — the allowlist refuses what it does not recognise, and refuses it BEFORE any
 *  upstream request is made.
 *
 *  Expected: `/api/vexa/recordings` and `/api/vexa/agent/chat` (real gateway surfaces the
 *  dashboard does not proxy) both return 404 from the DASHBOARD, and the stub gateway's request
 *  log gains no entry for either path — a forwarded probe would be the real failure here, not the
 *  404 itself.
 */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

for (const path of ["/api/vexa/recordings", "/api/vexa/agent/chat"]) {
  test(`${path} is a 404 from the dashboard and never reaches the gateway`, async ({ page, request }) => {
    await signIn(page, testEmail("allowlist"));
    // Wait for the list's own first load to land before snapshotting — signIn only waits for the
    // static "Meetings" heading, which renders before that client-side fetch resolves.
    await page.getByRole("heading", { name: "Design Review" }).waitFor();
    const before = await gatewayRequests(request);

    // `page.request`, not the bare `request` fixture — it shares the browser context's cookies,
    // so this probe carries the just-established session (an anonymous probe would be a 401 from
    // the gate, which would prove nothing about the allowlist itself).
    const res = await page.request.get(path);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");

    const after = await gatewayRequests(request);
    expect(after.length).toBe(before.length);
  });
}
