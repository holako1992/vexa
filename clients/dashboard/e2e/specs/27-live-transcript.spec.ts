/** Live transcript: a live meeting's lines arrive over the core's SSE feed, not the 5s poll.
 *
 *  Expected:
 *   - streamed lines appear (well inside one poll interval) with NO `GET /transcripts/by-id` after
 *     the first load; a draft refined then confirmed under one segment id is one line; a retract
 *     removes it; speaker names from `metadata.speaker_labels` apply to streamed lines;
 *   - a stream that drops and comes back refused falls back to polling (`/transcripts/by-id`
 *     re-read every 5s), and returns to streaming once the feed is available again; a feed that
 *     is absent from the start (no agent domain) is polling from the first load;
 *   - a drop reconnects with the last cursor as `Last-Event-ID`, and a line spoken during the gap
 *     arrives exactly once;
 *   - the page follows the live end; scrolling up stops it and shows "Jump to live", which brings
 *     the reader back and resumes following;
 *   - `meeting-end` ends the live view and reloads the finished transcript;
 *   - the allowlist admits only `meetings/<numeric id>/stream`, composes the upstream query from
 *     that id alone (the caller's query is dropped), forwards a well-formed `Last-Event-ID` and
 *     drops a malformed one.
 *
 *  The stub serves the feed in the producer's own shape (`../liveStreamStub.mjs`).
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { GATEWAY_URL } from "../ports.mjs";
import { gatewayRequests, resetStub, setMeetingStatus, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

type Seg = { segment_id: string; speaker: string; text: string; start: number; completed?: boolean };

async function push(request: APIRequestContext, segments: Seg[], meetingId = 101) {
  const res = await request.post(`${GATEWAY_URL}/__control/live/push`, { data: { meetingId, segments } });
  if (!res.ok()) throw new Error(`push failed: ${res.status()}`);
}
async function live(request: APIRequestContext, action: string, data: Record<string, unknown> = {}) {
  const res = await request.post(`${GATEWAY_URL}/__control/live/${action}`, { data: { meetingId: 101, ...data } });
  if (!res.ok()) throw new Error(`${action} failed: ${res.status()}`);
}
async function transcriptReads(request: APIRequestContext): Promise<number> {
  return (await gatewayRequests(request)).filter((r) => r.url === "/transcripts/by-id/101").length;
}
async function streamRequests(request: APIRequestContext) {
  return (await gatewayRequests(request)).filter((r) => r.url.startsWith("/agent/meeting/stream"));
}
const mode = (page: Page, m: string) => page.locator(`[role="status"][data-live-mode="${m}"]`);

async function openLive(page: Page, tag: string) {
  await signIn(page, testEmail(tag));
  await page.goto("/meetings/101");
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();
  await expect(mode(page, "streaming")).toBeVisible();
}

test("streamed lines appear without a poll; drafts update in place, retracts remove, labels apply", async ({ page, request }) => {
  await request.post(`${GATEWAY_URL}/meetings/101/annotate`, {
    headers: { "X-API-Key": "e2e" },
    data: { metadata: { speaker_labels: { Amy: "Amy Adams" } } },
  });
  await openLive(page, "live-stream");
  // The first load's REST read(s) — React's development double-mount may issue two.
  const readsAtOpen = await transcriptReads(request);
  expect(readsAtOpen).toBeGreaterThanOrEqual(1);

  const transcript = page.getByRole("list", { name: "Transcript" });
  await push(request, [{ segment_id: "s1", speaker: "Amy", text: "Morning all", start: 1, completed: false }]);
  await expect(transcript.getByText("Morning all", { exact: true })).toBeVisible({ timeout: 2_000 });
  await push(request, [{ segment_id: "s1", speaker: "Amy", text: "Morning all, let's begin.", start: 1, completed: true }]);
  await expect(transcript.getByText("Morning all, let's begin.")).toBeVisible({ timeout: 2_000 });
  await expect(transcript.getByText("Morning all", { exact: true })).toHaveCount(0);
  await expect(transcript.getByRole("listitem")).toHaveCount(1);
  await expect(transcript.getByText("Amy Adams", { exact: true })).toHaveCount(1);

  await push(request, [{ segment_id: "s2", speaker: "Ben", text: "Uh, wait", start: 4, completed: false }]);
  await expect(transcript.getByText("Uh, wait")).toBeVisible({ timeout: 2_000 });
  await live(request, "retract", { segmentIds: ["s2"] });
  await expect(transcript.getByText("Uh, wait")).toHaveCount(0, { timeout: 2_000 });

  // Past at least one poll interval: the stream carried everything, the transcript was never re-read.
  await page.waitForTimeout(6_000);
  expect(await transcriptReads(request)).toBe(readsAtOpen);
  // The row itself is still re-read (status, end of meeting).
  expect((await gatewayRequests(request)).filter((r) => r.url === "/meetings/101").length).toBeGreaterThan(1);
});

test("a dropped stream that comes back refused falls back to polling, then streams again", async ({ page, request }) => {
  test.setTimeout(75_000);
  await openLive(page, "live-fallback");
  await live(request, "unavailable", { mode: "refuse" });
  await live(request, "drop");
  await expect(mode(page, "polling")).toBeVisible({ timeout: 5_000 });

  const reads = await transcriptReads(request);
  await push(request, [{ segment_id: "p1", speaker: "Amy", text: "Heard through the poll", start: 2 }]);
  await expect(page.getByText("Heard through the poll")).toBeVisible({ timeout: 8_000 });
  expect(await transcriptReads(request)).toBeGreaterThan(reads);

  await live(request, "unavailable", { mode: null });
  await expect(mode(page, "streaming")).toBeVisible({ timeout: 40_000 });
  await push(request, [{ segment_id: "p2", speaker: "Amy", text: "Back on the stream", start: 3 }]);
  await expect(page.getByText("Back on the stream")).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText("Heard through the poll")).toHaveCount(1);
});

test("a feed that is absent from the start leaves the page polling", async ({ page, request }) => {
  await live(request, "unavailable", { mode: "absent" });
  await signIn(page, testEmail("live-absent"));
  await page.goto("/meetings/101");
  await expect(mode(page, "polling")).toBeVisible();
  await push(request, [{ segment_id: "a1", speaker: "Amy", text: "Polled line", start: 1 }]);
  await expect(page.getByText("Polled line")).toBeVisible({ timeout: 8_000 });
});

test("a drop reconnects with Last-Event-ID and the gap's line arrives exactly once", async ({ page, request }) => {
  await openLive(page, "live-resume");
  await push(request, [{ segment_id: "r1", speaker: "Amy", text: "Before the drop", start: 1 }]);
  await expect(page.getByText("Before the drop")).toBeVisible({ timeout: 2_000 });
  // Fresh connects carry no cursor (React's development double-mount may open, then close, one).
  const fresh = await streamRequests(request);
  const opened = fresh.length;
  expect(opened).toBeGreaterThanOrEqual(1);
  for (const r of fresh) expect(r.headers["last-event-id"]).toBeUndefined();

  await live(request, "drop");
  await push(request, [{ segment_id: "r2", speaker: "Amy", text: "During the gap", start: 2 }]);
  await expect.poll(async () => (await streamRequests(request)).length, { timeout: 5_000 }).toBe(opened + 1);
  const resumed = (await streamRequests(request))[opened]!;
  expect(resumed.headers["last-event-id"]).toMatch(/^\d+-\d+\|\$\|0-0$/);
  expect(resumed.url).toBe("/agent/meeting/stream?meeting_id=101&session_uid=101");

  await expect(page.getByText("During the gap")).toBeVisible({ timeout: 5_000 });
  await expect(mode(page, "streaming")).toBeVisible();
  await push(request, [{ segment_id: "r3", speaker: "Amy", text: "After the resume", start: 3 }]);
  await expect(page.getByText("After the resume")).toBeVisible({ timeout: 2_000 });
  for (const text of ["Before the drop", "During the gap", "After the resume"]) {
    await expect(page.getByText(text)).toHaveCount(1);
  }
});

test("follows the live end; scrolling up shows Jump to live, which brings the reader back", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await openLive(page, "live-follow");
  const many = Array.from({ length: 30 }, (_, i) => ({
    segment_id: `f${i}`, speaker: i % 2 ? "Ben" : "Amy", text: `Line number ${i} of the long meeting`, start: i * 3,
  }));
  await push(request, many);
  const newest = page.getByText("Line number 29 of the long meeting");
  await expect(newest).toBeInViewport({ timeout: 3_000 });
  const pill = page.getByRole("button", { name: "Jump to live" });
  await expect(pill).toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(pill).toBeVisible();
  await push(request, [{ segment_id: "f30", speaker: "Amy", text: "A line while reading back", start: 95 }]);
  await expect(page.getByText("A line while reading back")).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByText("A line while reading back")).not.toBeInViewport();

  await pill.click();
  await expect(page.getByText("A line while reading back")).toBeInViewport();
  await expect(pill).toHaveCount(0);
  await push(request, [{ segment_id: "f31", speaker: "Ben", text: "Followed again", start: 98 }]);
  await expect(page.getByText("Followed again")).toBeInViewport({ timeout: 3_000 });
});

test("meeting-end ends the live view and reloads the finished transcript", async ({ page, request }) => {
  await openLive(page, "live-end");
  await push(request, [{ segment_id: "e1", speaker: "Amy", text: "Thanks, bye", start: 1 }]);
  await expect(page.getByText("Thanks, bye")).toBeVisible({ timeout: 2_000 });
  const reads = await transcriptReads(request);
  await setMeetingStatus(request, 101, "completed");
  await live(request, "end");
  await expect(page.locator("[data-live-mode]")).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(() => transcriptReads(request), { timeout: 5_000 }).toBeGreaterThan(reads);
  await expect(page.getByText("Thanks, bye")).toHaveCount(1);
  // The feed is over: nothing reconnects it.
  const streams = (await streamRequests(request)).length;
  await page.waitForTimeout(3_000);
  expect((await streamRequests(request)).length).toBe(streams);
});

test("the allowlist admits only meetings/<numeric id>/stream and composes the upstream query itself", async ({ page, request }) => {
  await signIn(page, testEmail("live-allowlist"));
  await page.getByRole("heading", { name: "Design Review" }).waitFor();
  const before = (await gatewayRequests(request)).length;
  for (const path of [
    "/api/vexa/meetings/abc/stream",
    "/api/vexa/meetings/-1/stream",
    "/api/vexa/meetings/1.5/stream",
    "/api/vexa/meetings/101/stream/extra",
    "/api/vexa/meetings/stream",
    "/api/vexa/agent/meeting/stream?meeting_id=101&session_uid=101",
    "/api/vexa/meetings/%2e%2e/stream",
  ]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(404);
  }
  // A write to the stream path is refused (the same-origin write guard or the write allowlist).
  const post = await page.request.post("/api/vexa/meetings/101/stream", { data: {} });
  expect([403, 404]).toContain(post.status());
  expect((await gatewayRequests(request)).length).toBe(before);

  // A real stream request through the browser: the caller's own query and a malformed cursor stop
  // at the dashboard; a well-formed cursor rides through.
  await push(request, [{ segment_id: "q1", speaker: "Amy", text: "probe", start: 1 }]);
  const readFirstChunk = (url: string, lastEventId: string) =>
    page.evaluate(async ([u, id]) => {
      const ctl = new AbortController();
      const res = await fetch(u, { headers: { "Last-Event-ID": id }, signal: ctl.signal });
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      ctl.abort();
      return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), first: new TextDecoder().decode(value) };
    }, [url, lastEventId] as const);

  const first = await readFirstChunk("/api/vexa/meetings/101/stream?meeting_id=999&session_uid=999&lid=x", "garbage");
  expect(first.status).toBe(200);
  expect(first.type).toContain("text/event-stream");
  expect(first.cache).toContain("no-store");
  expect(first.first).toContain('"type":"transcript"');
  const resumed = await readFirstChunk("/api/vexa/meetings/101/stream", "0-0|$|0-0");
  expect(resumed.status).toBe(200);

  const streams = await streamRequests(request);
  expect(streams).toHaveLength(2);
  expect(streams[0]!.url).toBe("/agent/meeting/stream?meeting_id=101&session_uid=101");
  expect(streams[0]!.headers["last-event-id"]).toBeUndefined();
  expect(streams[1]!.headers["last-event-id"]).toBe("0-0|$|0-0");
});
