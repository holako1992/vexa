/** Tags and sorting on the meetings list, and the tag editor on a meeting.
 *
 *  Expected: tagged fixture rows (102, 105: "acme"; 105 also "internal") show their tags on the
 *  list; following a tag chip asks the GATEWAY for only that tag (`metadata={"tags":["acme"]}` on
 *  `GET /meetings`) and shows exactly the two tagged meetings; clearing the filter brings the rest
 *  back. On a meeting, adding "  Q3 Planning " stores the normalized "q3 planning" through
 *  annotate, and removing the last tag sends `null`. Another writer's metadata key on the same
 *  row (`crm_id`) survives both writes. Sorting by title keeps the live meeting first.
 */
import { test, expect } from "@playwright/test";
import { forceAnnotate, gatewayRequests, resetStub, signIn, testEmail } from "./helpers";
import { GATEWAY_URL } from "../ports.mjs";

test.beforeEach(async ({ request }) => { await resetStub(request); });

test("the list shows tags, and a tag chip filters on the server", async ({ page, request }) => {
  await signIn(page, testEmail("tags-filter"));
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();

  const filters = page.getByRole("group", { name: "Filter by tag" });
  await expect(filters.getByRole("link", { name: "acme" })).toBeVisible();
  await expect(filters.getByRole("link", { name: "internal" })).toBeVisible();

  const before = await gatewayRequests(request);
  await filters.getByRole("link", { name: "acme" }).click();
  await expect(page).toHaveURL(/\?tag=acme$/);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Design Review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Support Retro" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toHaveCount(0);

  const listCalls = (await gatewayRequests(request)).slice(before.length)
    .filter((r) => r.method === "GET" && r.url.startsWith("/meetings?"));
  expect(listCalls.length).toBeGreaterThan(0);
  for (const call of listCalls) {
    expect(new URL(call.url, "http://x").searchParams.get("metadata")).toBe('{"tags":["acme"]}');
  }

  await page.getByRole("link", { name: "Clear tag filter acme" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();
});

test("a tag with no meetings says so, rather than looking like an empty account", async ({ page }) => {
  await signIn(page, testEmail("tags-empty"));
  await page.goto("/?tag=nothing-here");
  await expect(page.getByText("No meetings tagged “nothing-here”.")).toBeVisible();
});

test("add and remove a tag on a meeting; other metadata keys survive", async ({ page, request }) => {
  await signIn(page, testEmail("tags-edit"));
  await page.goto("/meetings/102");
  const tags = page.getByRole("group", { name: "Tags" });
  await expect(tags.getByRole("link", { name: "Meetings tagged acme" })).toBeVisible();

  await tags.getByRole("button", { name: "Add tag" }).click();
  await tags.getByRole("textbox", { name: "New tag" }).fill("  Q3   Planning ");
  const before = await gatewayRequests(request);
  await tags.getByRole("textbox", { name: "New tag" }).press("Enter");
  await expect(tags.getByRole("link", { name: "Meetings tagged q3 planning" })).toBeVisible();
  const add = (await gatewayRequests(request)).slice(before.length).find((r) => r.method === "POST");
  expect(add?.url).toBe("/meetings/102/annotate");
  expect(add?.body).toEqual({ metadata: { tags: ["acme", "q3 planning"] } });

  await tags.getByRole("button", { name: "Remove tag acme" }).click();
  await expect(tags.getByRole("link", { name: "Meetings tagged acme" })).toHaveCount(0);
  await tags.getByRole("button", { name: "Remove tag q3 planning" }).click();
  await expect(tags.getByRole("link")).toHaveCount(0);
  const removes = (await gatewayRequests(request)).slice(before.length).filter((r) => r.method === "POST");
  expect(removes.map((r) => r.body)).toEqual([
    { metadata: { tags: ["acme", "q3 planning"] } },
    { metadata: { tags: ["q3 planning"] } },
    { metadata: { tags: null } },
  ]);

  // The row as the gateway now holds it: the tags key is gone, another writer's key is intact.
  const row = await (await request.get(`${GATEWAY_URL}/meetings/102`)).json();
  expect(row.data.metadata).toEqual({ crm_id: "e2e-not-the-dashboards" });
});

test("a failed tag write leaves the tags as they were", async ({ page, request }) => {
  await signIn(page, testEmail("tags-fail"));
  await page.goto("/meetings/102");
  await forceAnnotate(request, 500);
  const tags = page.getByRole("group", { name: "Tags" });
  await tags.getByRole("button", { name: "Remove tag acme" }).click();
  await expect(page.getByText("Couldn't update tags")).toBeVisible();
  await expect(tags.getByRole("link", { name: "Meetings tagged acme" })).toBeVisible();
});

test("a shared meeting shows the owner's tags with no editor", async ({ page, request }) => {
  await request.post(`${GATEWAY_URL}/meetings/104/annotate`, { data: { metadata: { tags: ["standup"] } } });
  await signIn(page, testEmail("tags-shared"));
  await page.goto("/meetings/104");
  const tags = page.getByRole("group", { name: "Tags" });
  await expect(tags.getByRole("link", { name: "Meetings tagged standup" })).toBeVisible();
  await expect(tags.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Speakers" })).toHaveCount(0);
});

test("sorting by title reorders the loaded rows, live meeting first", async ({ page }) => {
  await signIn(page, testEmail("tags-sort"));
  await expect(page.getByRole("heading", { name: "Weekly Sync" })).toBeVisible();
  await page.getByRole("combobox", { name: "Sort meetings" }).selectOption("title");
  const titles = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(titles[0]).toBe("Weekly Sync"); // the live one
  const rest = titles.slice(1);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })));
});
