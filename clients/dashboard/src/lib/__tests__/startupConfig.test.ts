/** The production start-up refusal: only a production server without the oracle secret is refused. */
import { describe, expect, it } from "vitest";
import { startupRefusal } from "../startupConfig";

describe("startupRefusal", () => {
  it("refuses production without the secret, naming it", () => {
    for (const secret of [undefined, "", "   "]) {
      expect(startupRefusal({ NODE_ENV: "production", VEXA_INTERNAL_API_SECRET: secret })).toContain("VEXA_INTERNAL_API_SECRET");
    }
  });

  it("allows production with the secret", () => {
    expect(startupRefusal({ NODE_ENV: "production", VEXA_INTERNAL_API_SECRET: "s3" })).toBeNull();
  });

  it("never refuses development or test", () => {
    expect(startupRefusal({ NODE_ENV: "development" })).toBeNull();
    expect(startupRefusal({ NODE_ENV: "test" })).toBeNull();
    expect(startupRefusal({})).toBeNull();
  });

  it("never refuses the production build phase", () => {
    expect(startupRefusal({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBeNull();
  });
});
