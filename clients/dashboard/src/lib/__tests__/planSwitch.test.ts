import { describe, expect, it } from "vitest";
import { planName, switchButtonLabel, switchExplanation, switchKind, type SubscriptionView } from "../planSwitch";

const sub = (plan: string, interval: string, pending: SubscriptionView["pending_change"] = null): SubscriptionView => ({
  plan,
  interval,
  pending_change: pending,
});

describe("switchKind", () => {
  it("names the card the subscription already is", () => {
    expect(switchKind(sub("pro", "month"), "pro", "month")).toBe("current");
  });

  it("an upgrade on the same interval applies now", () => {
    expect(switchKind(sub("pro", "month"), "team", "month")).toBe("now");
    expect(switchKind(sub("pro", "year"), "team", "year")).toBe("now");
  });

  it("a downgrade, or any interval switch, waits for the period end", () => {
    expect(switchKind(sub("team", "month"), "pro", "month")).toBe("scheduled");
    expect(switchKind(sub("pro", "month"), "pro", "year")).toBe("scheduled");
    expect(switchKind(sub("pro", "year"), "pro", "month")).toBe("scheduled");
    expect(switchKind(sub("pro", "month"), "team", "year")).toBe("scheduled");
  });

  it("names the card a switch is already scheduled to", () => {
    const s = sub("team", "month", { plan: "pro", interval: "month", at: "2026-11-02T00:00:00+00:00" });
    expect(switchKind(s, "pro", "month")).toBe("pending");
    expect(switchKind(s, "pro", "year")).toBe("scheduled");
  });
});

describe("switchButtonLabel", () => {
  it("labels each card for a Pro monthly subscriber", () => {
    const s = sub("pro", "month");
    expect(switchButtonLabel(s, "pro", "month")).toBe("Current plan");
    expect(switchButtonLabel(s, "team", "month")).toBe("Switch to Team");
    expect(switchButtonLabel(s, "pro", "year")).toBe("Switch to yearly");
    expect(switchButtonLabel(s, "team", "year")).toBe("Switch to Team");
  });

  it("marks the pending target as scheduled", () => {
    const s = sub("team", "month", { plan: "pro", interval: "month", at: "x" });
    expect(switchButtonLabel(s, "pro", "month")).toBe("Scheduled");
  });
});

describe("switchExplanation", () => {
  it("an immediate upgrade charges nothing today", () => {
    expect(switchExplanation(sub("pro", "month"), "team", "month", "2 Nov", "$20 / month")).toBe(
      "Team starts now. Nothing is charged today; from your renewal on 2 Nov you'll be billed $20 / month.",
    );
  });

  it("an upgrade that also changes interval starts the plan now and the interval at renewal", () => {
    expect(switchExplanation(sub("pro", "month"), "team", "year", "2 Nov", "$100 / year")).toBe(
      "Team starts now at your current monthly rate. From your renewal on 2 Nov you'll be on Team yearly, billed $100 / year.",
    );
  });

  it("a downgrade keeps the current plan until renewal", () => {
    expect(switchExplanation(sub("team", "month"), "pro", "month", "2 Nov", "$5 / month")).toBe(
      "You'll keep Team monthly until 2 Nov, then move to Pro monthly, billed $5 / month.",
    );
  });

  it("names the plan when Stripe gave no price", () => {
    expect(switchExplanation(sub("pro", "month"), "pro", "year", "2 Nov", null)).toBe(
      "You'll keep Pro monthly until 2 Nov, then move to Pro yearly, billed the Pro yearly price.",
    );
  });
});

describe("planName", () => {
  it("joins plan and interval", () => {
    expect(planName("team", "year")).toBe("Team yearly");
    expect(planName("pro", null)).toBe("Pro");
  });
});
