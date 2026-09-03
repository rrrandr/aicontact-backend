import {
  resolveSubscriptionId,
  subscriptionSource,
  SubscriptionMismatch,
} from "../../scripts/lib/sandboxState";

describe("resolving which sandbox subscription to act on", () => {
  it("falls back to the id phase 1 recorded", () => {
    // The point of the state file: no manual copying between steps.
    expect(
      resolveSubscriptionId({ envValue: undefined, state: { subscription_id: "I-STATE001" } })
    ).toBe("I-STATE001");
    expect(
      resolveSubscriptionId({ envValue: "", state: { subscription_id: "I-STATE001" } })
    ).toBe("I-STATE001");
  });

  it("lets an explicit environment value override", () => {
    expect(resolveSubscriptionId({ envValue: "I-ENV0001", state: {} })).toBe("I-ENV0001");
  });

  it("refuses when the override and the recorded id disagree", () => {
    // Silently preferring one would run the whole lifecycle against a
    // different subscription than the one on record.
    expect(() =>
      resolveSubscriptionId({
        envValue: "I-ENV0001",
        state: { subscription_id: "I-STATE001" },
      })
    ).toThrow(SubscriptionMismatch);
  });

  it("accepts an override that agrees, including with stray whitespace", () => {
    expect(
      resolveSubscriptionId({
        envValue: "  I-SAME001  ",
        state: { subscription_id: "I-SAME001" },
      })
    ).toBe("I-SAME001");
  });

  it("returns null when there is nothing to act on", () => {
    expect(resolveSubscriptionId({ envValue: undefined, state: {} })).toBeNull();
    expect(resolveSubscriptionId({})).toBeNull();
    expect(resolveSubscriptionId()).toBeNull();
  });

  it("reports where the id came from", () => {
    expect(subscriptionSource({ envValue: "I-ENV", state: {} })).toBe("environment override");
    expect(subscriptionSource({ state: { subscription_id: "I-STATE" } })).toBe("state file");
    expect(subscriptionSource({})).toBe("none");
  });
});
