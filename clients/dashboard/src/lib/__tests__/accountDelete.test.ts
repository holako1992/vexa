/** Account deletion's pure parts: the typed-email check, the fixed notice, and the bounded retry
 *  that turns admin-api's statuses into one outcome. No network: the admin call is a stub. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../session", () => ({ sessionToken: async () => undefined }));

import { ACCOUNT_DELETED, DELETE_FAILURE_TEXT, emailMatches, loginNotice } from "../account";
import { DELETE_ATTEMPTS, runAccountDeletion } from "../accountApi";

describe("emailMatches", () => {
  it("accepts the account's own address, trimmed and in any case", () => {
    expect(emailMatches("me@x.test", "me@x.test")).toBe(true);
    expect(emailMatches("  Me@X.Test ", "me@x.test")).toBe(true);
  });

  it("refuses everything else, including an empty or non-string confirmation", () => {
    expect(emailMatches("", "me@x.test")).toBe(false);
    expect(emailMatches("   ", "")).toBe(false);
    expect(emailMatches("other@x.test", "me@x.test")).toBe(false);
    expect(emailMatches("me@x.test.evil", "me@x.test")).toBe(false);
    expect(emailMatches(undefined, "me@x.test")).toBe(false);
    expect(emailMatches(7, "me@x.test")).toBe(false);
    expect(emailMatches(["me@x.test"], "me@x.test")).toBe(false);
  });
});

describe("the account-deleted notice", () => {
  it("is chosen by its fixed code and by nothing else", () => {
    expect(loginNotice(ACCOUNT_DELETED)).toContain("deleted");
    expect(loginNotice("<b>deleted</b>")).toBeNull();
  });

  it("has a fixed sentence for every failure", () => {
    expect(Object.keys(DELETE_FAILURE_TEXT).sort()).toEqual(["blocked", "last_admin", "partial", "unavailable"]);
  });
});

describe("runAccountDeletion", () => {
  async function run(statuses: number[]) {
    const seen: number[] = [];
    const sleeps: number[] = [];
    const call = async () => {
      const status = statuses[Math.min(seen.length, statuses.length - 1)];
      seen.push(status);
      return { ok: status >= 200 && status < 300, status };
    };
    const outcome = await runAccountDeletion(call, async (ms) => { sleeps.push(ms); });
    return { outcome, seen, sleeps };
  }

  it("treats 200 and an already-gone 404 as deleted, after one call", async () => {
    expect(await run([200])).toMatchObject({ outcome: "deleted", seen: [200] });
    expect(await run([404])).toMatchObject({ outcome: "deleted", seen: [404] });
  });

  it("does not retry a refusal", async () => {
    expect(await run([409])).toMatchObject({ outcome: "blocked", seen: [409] });
  });

  it("names the last-admin refusal by its code only, never by the core's sentence", async () => {
    const once = (error: string) => runAccountDeletion(async () => ({ ok: false, status: 409, error }), async () => {});
    expect(await once(JSON.stringify({ error: "last_admin", detail: "anything" }))).toBe("last_admin");
    expect(await once(JSON.stringify({ error: "something_else" }))).toBe("blocked");
    expect(await once("not json")).toBe("blocked");
    expect(await once(JSON.stringify({ error: { nested: true } }))).toBe("blocked");
  });

  it("retries a partial and finishes when the core does", async () => {
    expect(await run([502, 200])).toMatchObject({ outcome: "deleted", seen: [502, 200] });
  });

  it("gives up after the bounded attempts and reports partial, never deleted", async () => {
    const r = await run([502]);
    expect(r.outcome).toBe("partial");
    expect(r.seen).toHaveLength(DELETE_ATTEMPTS);
    expect(r.sleeps).toHaveLength(DELETE_ATTEMPTS - 1);
  });

  it("says unavailable, without retrying, for an unreachable or unexpected answer", async () => {
    expect(await run([0])).toMatchObject({ outcome: "unavailable", seen: [0] });
    expect(await run([500])).toMatchObject({ outcome: "unavailable", seen: [500] });
  });
});
