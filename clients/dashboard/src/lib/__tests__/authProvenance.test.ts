/** What each sign-in door tells admin-api about the address. Google's claim is read literally: only
 *  a boolean `true` verifies, so a missing, string or truthy-but-not-true value cannot. */
import { describe, expect, it } from "vitest";
import { provenanceFor } from "../../app/api/auth/authOptions";

describe("provenanceFor", () => {
  it("Google: a literal email_verified true is verified", () => {
    expect(provenanceFor("google", { email_verified: true })).toEqual({ provider: "google", emailVerified: true });
  });

  it("Google: false, absent, string and non-object profiles are all unverified", () => {
    for (const profile of [{ email_verified: false }, {}, { email_verified: "true" }, { email_verified: 1 }, null, undefined, "x"]) {
      expect(provenanceFor("google", profile)).toEqual({ provider: "google", emailVerified: false });
    }
  });

  it("Microsoft: verified regardless of the profile", () => {
    expect(provenanceFor("microsoft", {})).toEqual({ provider: "microsoft", emailVerified: true });
    expect(provenanceFor("microsoft", null)).toEqual({ provider: "microsoft", emailVerified: true });
  });
});
