import {
  planPayload,
  PLAN_NAME,
  TRIAL_INTERVAL_UNIT,
  TRIAL_INTERVAL_COUNT,
} from "../../scripts/lib/catalogue";

/**
 * The sandbox plan has to mirror the live AICONTACT plan, because a sandbox
 * test only proves something if the thing under test is shaped the same:
 * one free 13-day cycle, then $6 monthly until cancelled.
 */
describe("sandbox plan payload mirrors the live AICONTACT plan", () => {
  const payload = planPayload("PROD-TEST", { price: "6.00", currency: "USD" });
  const cycles = payload.billing_cycles;
  const trial = cycles.find((c) => c.tenure_type === "TRIAL");
  const regular = cycles.find((c) => c.tenure_type === "REGULAR");

  it("has exactly one trial cycle and one regular cycle", () => {
    expect(cycles).toHaveLength(2);
    expect(trial).toBeDefined();
    expect(regular).toBeDefined();
  });

  it("charges nothing for a single 13-day trial", () => {
    expect(trial.frequency).toEqual({
      interval_unit: TRIAL_INTERVAL_UNIT,
      interval_count: TRIAL_INTERVAL_COUNT,
    });
    expect(TRIAL_INTERVAL_UNIT).toBe("DAY");
    expect(TRIAL_INTERVAL_COUNT).toBe(13);
    expect(trial.pricing_scheme.fixed_price.value).toBe("0.00");
    // Exactly one: a repeating trial would never start billing.
    expect(trial.total_cycles).toBe(1);
  });

  it("puts the trial first so the paid cycle follows it", () => {
    expect(trial.sequence).toBe(1);
    expect(regular.sequence).toBe(2);
  });

  it("then bills monthly, unlimited, at the live price", () => {
    expect(regular.frequency).toEqual({ interval_unit: "MONTH", interval_count: 1 });
    expect(regular.pricing_scheme.fixed_price).toEqual({
      value: "6.00",
      currency_code: "USD",
    });
    // 0 = renews until cancelled.
    expect(regular.total_cycles).toBe(0);
  });

  it("keeps the plan active and named", () => {
    expect(payload.status).toBe("ACTIVE");
    expect(payload.name).toBe(PLAN_NAME);
    expect(payload.description).toMatch(/13-day free trial/i);
  });

  it("still validates price and currency", () => {
    expect(() => planPayload("PROD-TEST", { price: "6", currency: "USD" })).toThrow(/price/);
    expect(() => planPayload("PROD-TEST", { price: "6.00", currency: "usd" })).toThrow(/currency/);
    expect(() => planPayload(null, { price: "6.00", currency: "USD" })).toThrow(/product id/);
  });

  it("uses the trial currency for the free cycle too", () => {
    const eur = planPayload("PROD-TEST", { price: "6.00", currency: "EUR" });
    const eurTrial = eur.billing_cycles.find((c) => c.tenure_type === "TRIAL");
    expect(eurTrial.pricing_scheme.fixed_price.currency_code).toBe("EUR");
  });
});
