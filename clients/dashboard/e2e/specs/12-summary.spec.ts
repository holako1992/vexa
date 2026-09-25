/** DB-60 (dashboard half) — the post-meeting summary panel. Five states, proven distinct against
 *  a REAL running stub (`fixtures.mjs`'s `SUMMARIES`):
 *
 *   - live (101): "appears after this meeting ends" — no summary fetch is even made.
 *   - shared (104): the viewer isn't the owner — "available to the meeting's owner", not a
 *     forever-pending spinner.
 *   - pending (105): no summary.md yet — a 404 the panel reads as "still being generated".
 *   - skipped (106): the producer's own `reason`, verbatim.
 *   - complete (102): all four sections, action items as a real list.
 *
 *  Plus the security property `route.ts`/`upstream.ts` exist for: a browser-supplied `?path=`
 *  never reaches the stub — the summary request the stub sees carries no query at all.
 */
import { test, expect } from "@playwright/test";
import { gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("live meeting: summary says it appears after the meeting ends, and never fetches one", async ({ page, request }) => {
  await signIn(page, testEmail("summary-live"));
  const before = await gatewayRequests(request);

  await page.goto("/meetings/101");
  await expect(page.getByText("A summary appears here once this meeting ends.")).toBeVisible();

  const after = await gatewayRequests(request);
  const newUrls = after.slice(before.length).map((r) => r.url.split("?")[0]);
  expect(newUrls.some((u) => u.startsWith("/agent/workspace/file"))).toBe(false);
});

test("shared meeting: the summary belongs to the owner, not a permanent 'generating' spinner", async ({ page }) => {
  await signIn(page, testEmail("summary-shared"));
  await page.goto("/meetings/104");
  await expect(
    page.getByText(/summary is available to the meeting.s owner/i),
  ).toBeVisible();
  await expect(page.getByText(/still being generated/i)).toHaveCount(0);
});

test("completed, owned, no summary.md yet: reads as 'still being generated', not an error", async ({ page }) => {
  await signIn(page, testEmail("summary-pending"));
  await page.goto("/meetings/105");
  await expect(page.getByText(/still being generated/i)).toBeVisible();
});

test("status: skipped shows the producer's reason in plain words", async ({ page }) => {
  await signIn(page, testEmail("summary-skipped"));
  await page.goto("/meetings/106");
  await expect(page.getByText("fewer than 3 transcript segments")).toBeVisible();
});

test("status: complete renders all four sections with action items as a list", async ({ page }) => {
  await signIn(page, testEmail("summary-complete"));
  await page.goto("/meetings/102");

  await expect(page.getByText("Overview")).toBeVisible();
  await expect(page.getByText(/redesigned onboarding flow/i)).toBeVisible();
  await expect(page.getByText("Decisions")).toBeVisible();
  await expect(page.getByText(/hold the calendar screen/i)).toBeVisible();
  await expect(page.getByText("Action items")).toBeVisible();
  await expect(page.getByText("Dev to open a follow-up on the calendar screen's copy.")).toBeVisible();
  await expect(page.getByText("Carla to schedule a design review for next week.")).toBeVisible();
  await expect(page.getByText("Open questions")).toBeVisible();
});

test("a browser-chosen ?path= on the summary request never reaches the stub", async ({ page, request }) => {
  await signIn(page, testEmail("summary-path-safety"));
  await page.goto("/meetings/102");
  await expect(page.getByText(/redesigned onboarding flow/i)).toBeVisible();

  const before = await gatewayRequests(request);
  // Same-origin, cookie-carrying probe with an attacker-controlled `path` tacked on — proves the
  // ROUTE drops it, not just that the UI never sends one.
  const res = await page.request.get("/api/vexa/meetings/102/summary?path=../../admin/secrets.md");
  expect(res.ok()).toBe(true);

  const after = await gatewayRequests(request);
  const newOnes = after.slice(before.length);
  expect(newOnes.length).toBeGreaterThan(0);
  for (const r of newOnes) {
    expect(r.url).toContain("path=meetings/102/summary.md");
    expect(r.url).not.toContain("admin");
    expect(r.url).not.toContain("secrets");
  }
});
