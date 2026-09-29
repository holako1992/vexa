/** A refused sign-in must reach the person as a fixed sentence, chosen from a closed set. These
 *  tests pin the mapping from admin-api's body to a code, and from a code (or a hostile query
 *  value) to words. */
import { describe, expect, it } from "vitest";
import { REFUSAL_MESSAGES, SignInRefusal, isRefusalCode, refusalFromAdmin, refusalMessage } from "../signInRefusal";

const DISPOSABLE_BODY = JSON.stringify({
  detail: { error: "disposable_email_domain", message: "This email domain is a disposable/throwaway provider." },
});

describe("refusalFromAdmin", () => {
  it("reads admin-api's typed disposable-domain refusal", () => {
    const r = refusalFromAdmin(422, DISPOSABLE_BODY);
    expect(r).toBeInstanceOf(SignInRefusal);
    expect(r.code).toBe("disposable_email_domain");
  });

  it("maps a client error with an unknown code, a bare string, or unparseable text to the generic refusal", () => {
    expect(refusalFromAdmin(422, JSON.stringify({ detail: { error: "something_new" } })).code).toBe("sign_in_failed");
    expect(refusalFromAdmin(422, JSON.stringify({ detail: "plain string" })).code).toBe("sign_in_failed");
    expect(refusalFromAdmin(403, "<html>nope</html>").code).toBe("sign_in_failed");
    expect(refusalFromAdmin(400, undefined).code).toBe("sign_in_failed");
    expect(refusalFromAdmin(422, "null").code).toBe("sign_in_failed");
  });

  it("does not let a body name the transient code on a client error", () => {
    expect(refusalFromAdmin(422, JSON.stringify({ detail: { error: "unavailable" } })).code).toBe("sign_in_failed");
  });

  it("treats network failure, timeout and server errors as unavailable, whatever the body says", () => {
    expect(refusalFromAdmin(0, "admin-api request timed out").code).toBe("unavailable");
    expect(refusalFromAdmin(503, DISPOSABLE_BODY).code).toBe("unavailable");
    expect(refusalFromAdmin(500, undefined).code).toBe("unavailable");
  });
});

describe("refusalMessage", () => {
  it("gives each known code its own fixed copy", () => {
    for (const code of Object.keys(REFUSAL_MESSAGES) as (keyof typeof REFUSAL_MESSAGES)[]) {
      expect(refusalMessage(code)).toBe(REFUSAL_MESSAGES[code]);
    }
    expect(refusalMessage("disposable_email_domain")).toMatch(/disposable/i);
  });

  it("shows nothing when there is no error", () => {
    expect(refusalMessage(null)).toBeNull();
    expect(refusalMessage(undefined)).toBeNull();
    expect(refusalMessage("")).toBeNull();
  });

  it("never reflects an unknown value: NextAuth names and hostile text both get the generic copy", () => {
    for (const v of ["AccessDenied", "OAuthCallback", "<script>alert(1)</script>", "constructor", "__proto__", "toString"]) {
      expect(refusalMessage(v)).toBe(REFUSAL_MESSAGES.sign_in_failed);
    }
  });
});

describe("isRefusalCode", () => {
  it("accepts only own keys of the table", () => {
    expect(isRefusalCode("unavailable")).toBe(true);
    expect(isRefusalCode("hasOwnProperty")).toBe(false);
    expect(isRefusalCode(42)).toBe(false);
  });
});
