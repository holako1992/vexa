import { afterEach, describe, expect, it } from "vitest";
import { ICS_GUIDES, icsGuide } from "../icsGuide";
import { rememberCalendarReturn, takeCalendarReturn } from "../calendarOAuth";

describe("ICS_GUIDES", () => {
  it("covers Google, Outlook, Apple and Other, each with numbered steps and a placeholder", () => {
    expect(ICS_GUIDES.map((g) => g.id)).toEqual(["google", "outlook", "apple", "other"]);
    for (const g of ICS_GUIDES) {
      expect(g.steps.length).toBeGreaterThan(1);
      expect(g.placeholder).toMatch(/^https:\/\//);
    }
  });

  it("links only to the providers' own https settings pages", () => {
    for (const g of ICS_GUIDES) {
      for (const link of [g.settings, g.altSettings]) {
        if (!link) continue;
        expect(link.href).toMatch(/^https:\/\/(calendar\.google\.com|outlook\.office\.com|outlook\.live\.com|www\.icloud\.com)\//);
      }
    }
  });

  it("tells Google users to take the secret address, not the public one", () => {
    expect(icsGuide("google").steps.map((s) => s.text).join(" ")).toMatch(/Secret address in iCal format.*not.*Public address/);
  });

  it("tells Apple and Other users to swap webcal:// for https:// (admin-api accepts only http(s))", () => {
    for (const id of ["apple", "other"] as const) {
      expect(icsGuide(id).steps.map((s) => s.text).join(" ")).toMatch(/webcal:\/\/.*https:\/\//);
    }
  });

  it("any screenshot a step names lives under /help/ics/", () => {
    for (const g of ICS_GUIDES) for (const s of g.steps) if (s.image) expect(s.image).toMatch(/^\/help\/ics\/[\w-]+\.(png|jpe?g|webp)$/);
  });
});

describe("calendar OAuth return target", () => {
  afterEach(() => window.sessionStorage.clear());

  it("is remembered once and then forgotten", () => {
    rememberCalendarReturn("/calendar");
    expect(takeCalendarReturn()).toBe("/calendar");
    expect(takeCalendarReturn()).toBeNull();
  });

  it("defaults to the meetings page, and clearing it clears it", () => {
    expect(takeCalendarReturn()).toBeNull();
    rememberCalendarReturn("/calendar");
    rememberCalendarReturn(null);
    expect(takeCalendarReturn()).toBeNull();
  });

  it("never returns a path it did not choose", () => {
    window.sessionStorage.setItem("vexa.calendar-oauth-return", "https://evil.example/");
    expect(takeCalendarReturn()).toBeNull();
  });
});
