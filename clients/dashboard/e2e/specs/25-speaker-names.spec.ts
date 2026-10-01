/** Speaker names: "Dev" becomes "Devon Lee" on every line, survives a reload, rides into exports,
 *  and clears back to the producer's attribution.
 *
 *  Expected: saving sends exactly `{metadata: {speaker_labels: {...}}}` to
 *  `POST /meetings/102/annotate`; the transcript re-renders with the name; a reload reads it back
 *  off the meeting row; the text export uses it; clearing the only name sends
 *  `speaker_labels: null`. Negative control: an annotate body naming any other metadata key is
 *  refused by the dashboard and never reaches the gateway.
 */
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { forceAnnotate, gatewayRequests, resetStub, signIn, testEmail } from "./helpers";

test.beforeEach(async ({ request }) => { await resetStub(request); });

const DEV_LINE = "Sure — I pushed the updated mockups last night.";

test("rename a speaker, see it on every line, keep it across a reload, export it, then clear it", async ({ page, request }) => {
  await signIn(page, testEmail("speaker-names"));
  await page.goto("/meetings/102");
  await expect(page.getByText(DEV_LINE)).toBeVisible();

  await page.getByRole("button", { name: "Speakers" }).click();
  const dialog = page.getByRole("dialog", { name: "Name the speakers" });
  await expect(dialog.getByLabel("Carla")).toHaveValue("");
  await dialog.getByLabel("Dev").fill("Devon Lee");

  const before = await gatewayRequests(request);
  await dialog.getByRole("button", { name: "Save names" }).click();
  await expect(page.getByText("Speaker names saved.")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const writes = (await gatewayRequests(request)).slice(before.length).filter((r) => r.method === "POST");
  expect(writes).toHaveLength(1);
  expect(writes[0]!.url).toBe("/meetings/102/annotate");
  expect(writes[0]!.body).toEqual({ metadata: { speaker_labels: { Dev: "Devon Lee" } } });

  // Both of Dev's lines now carry the name; Carla's are untouched.
  const transcript = page.getByRole("list", { name: "Transcript" });
  await expect(transcript.getByText("Devon Lee", { exact: true })).toHaveCount(2);
  await expect(transcript.getByText("Dev", { exact: true })).toHaveCount(0);
  await expect(transcript.getByText("Carla", { exact: true })).toHaveCount(3);

  await page.reload();
  await expect(transcript.getByText("Devon Lee", { exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: "Export" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("dialog", { name: "Export transcript" }).getByRole("button", { name: /Plain text/ }).click(),
  ]);
  const txt = (await readFile((await download.path())!)).toString("utf8");
  expect(txt).toContain(`Devon Lee: ${DEV_LINE}`);
  expect(txt).not.toContain(`Dev: ${DEV_LINE}`);

  await page.getByRole("button", { name: "Speakers" }).click();
  const again = page.getByRole("dialog", { name: "Name the speakers" });
  await expect(again.getByLabel("Dev")).toHaveValue("Devon Lee");
  await again.getByLabel("Dev").fill("");
  const beforeClear = await gatewayRequests(request);
  await again.getByRole("button", { name: "Save names" }).click();
  await expect(transcript.getByText("Dev", { exact: true })).toHaveCount(2);
  const clear = (await gatewayRequests(request)).slice(beforeClear.length).find((r) => r.method === "POST");
  expect(clear?.body).toEqual({ metadata: { speaker_labels: null } });
});

test("a failed save keeps the dialog open and the page unchanged", async ({ page, request }) => {
  await signIn(page, testEmail("speaker-names-fail"));
  await page.goto("/meetings/102");
  await expect(page.getByText(DEV_LINE)).toBeVisible();
  await forceAnnotate(request, 500);

  await page.getByRole("button", { name: "Speakers" }).click();
  const dialog = page.getByRole("dialog", { name: "Name the speakers" });
  await dialog.getByLabel("Dev").fill("Devon Lee");
  await dialog.getByRole("button", { name: "Save names" }).click();
  await expect(page.getByText("Couldn't save speaker names")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("list", { name: "Transcript" }).getByText("Devon Lee", { exact: true })).toHaveCount(0);
});

test("the annotate allowlist refuses any metadata key the dashboard does not own", async ({ page, request }) => {
  await signIn(page, testEmail("speaker-names-allowlist"));
  const before = await gatewayRequests(request);
  const status = await page.evaluate(async () => {
    const r = await fetch("/api/vexa/meetings/102/annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: { crm_id: "overwritten" } }),
    });
    return r.status;
  });
  expect(status).toBe(400);
  const after = (await gatewayRequests(request)).slice(before.length);
  expect(after.some((r) => r.url.startsWith("/meetings/102/annotate"))).toBe(false);
});
