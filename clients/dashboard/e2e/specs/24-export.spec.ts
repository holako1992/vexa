/** Transcript export: every format downloads what the page shows.
 *
 *  Expected: on meeting 102 the Export dialog offers text, Markdown, Word, SubRip and WebVTT; each
 *  download carries every transcript line in order under the speaker shown on the page; "Copy as
 *  Markdown" puts the same Markdown on the clipboard; PDF opens the browser's print dialog, and
 *  the print stylesheet keeps the transcript while dropping the app's navigation and controls.
 */
import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

/** The fixture transcript for meeting 102 (`../fixtures.mjs`), as the page shows it. */
const LINES = [
  ["Carla", "Let's start with the new onboarding flow."],
  ["Dev", "Sure — I pushed the updated mockups last night."],
  ["Carla", "Nice, the empty states read a lot clearer now."],
  ["Dev", "Agreed. Next up is the calendar connection screen."],
  ["Carla", "Let's walk through that one together."],
] as const;

async function openDesignReview(page: Page) {
  await page.goto("/meetings/102");
  await expect(page.getByText(LINES[0][1])).toBeVisible();
}

async function exportAs(page: Page, label: RegExp): Promise<{ name: string; body: Buffer }> {
  await page.getByRole("button", { name: "Export" }).click();
  const dialog = page.getByRole("dialog", { name: "Export transcript" });
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: label }).click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), body: await readFile(path!) };
}

test("SubRip: one numbered cue per line, timed from the producer's offsets", async ({ page }) => {
  await signIn(page, testEmail("export-srt"));
  await openDesignReview(page);
  const { name, body } = await exportAs(page, /^SubRip/);
  expect(name).toBe("Design-Review.srt");
  const blocks = body.toString("utf8").trim().split("\n\n");
  expect(blocks).toHaveLength(LINES.length);
  expect(blocks[0]).toBe("1\n00:00:00,000 --> 00:00:08,500\nCarla: Let's start with the new onboarding flow.");
  blocks.forEach((b, i) => expect(b.split("\n")[2]).toBe(`${LINES[i]![0]}: ${LINES[i]![1]}`));
});

test("WebVTT: header plus a voice-tagged cue per line", async ({ page }) => {
  await signIn(page, testEmail("export-vtt"));
  await openDesignReview(page);
  const { name, body } = await exportAs(page, /^WebVTT/);
  expect(name).toBe("Design-Review.vtt");
  const text = body.toString("utf8");
  expect(text.startsWith("WEBVTT\n\n")).toBe(true);
  for (const [speaker, line] of LINES) expect(text).toContain(`<v ${speaker}>${line}`);
});

test("Markdown and plain text carry every line in order", async ({ page }) => {
  await signIn(page, testEmail("export-md"));
  await openDesignReview(page);
  const md = (await exportAs(page, /^Markdown/)).body.toString("utf8");
  expect(md.startsWith("# Design Review\n")).toBe(true);
  expect(md).toContain("- **Platform:** Zoom");
  expect(md).toContain("- **Tags:** acme");
  let at = 0;
  for (const [speaker, line] of LINES) {
    const i = md.indexOf(`**${speaker}**`, at);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(md.indexOf(line, i)).toBeGreaterThan(i);
    at = md.indexOf(line, i);
  }

  const txt = (await exportAs(page, /^Plain text/)).body.toString("utf8");
  for (const [speaker, line] of LINES) expect(txt).toContain(`${speaker}: ${line}`);
});

test("Word: a .docx package whose document holds every line", async ({ page }) => {
  await signIn(page, testEmail("export-docx"));
  await openDesignReview(page);
  const { name, body } = await exportAs(page, /^Word/);
  expect(name).toBe("Design-Review.docx");
  expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  // Stored (uncompressed) entries, so the document XML is readable straight out of the bytes.
  const raw = body.toString("utf8");
  expect(raw).toContain("word/document.xml");
  for (const [speaker, line] of LINES) {
    expect(raw).toContain(`${speaker} [`);
    expect(raw).toContain(line);
  }
});

test("Copy as Markdown puts the export on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, testEmail("export-copy-md"));
  await openDesignReview(page);
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("button", { name: "Copy as Markdown" }).click();
  await expect(page.getByText("Copied as Markdown.")).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.startsWith("# Design Review\n")).toBe(true);
  expect(clip).toContain(`**Dev** \\[0:08\\]: ${LINES[1][1]}`);
});

test("PDF opens the print dialog, and print keeps the transcript but not the app's controls", async ({ page }) => {
  await signIn(page, testEmail("export-pdf"));
  await openDesignReview(page);
  await page.evaluate(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => { (window as unknown as { __printed: number }).__printed += 1; };
  });
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("button", { name: /^PDF/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();
  for (const [, line] of LINES) await expect(page.getByText(line)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Export" })).toBeHidden();
  await expect(page.getByRole("searchbox", { name: "Search this transcript" })).toBeHidden();
  await expect(page.getByRole("link", { name: "All meetings" })).toBeHidden();
});
