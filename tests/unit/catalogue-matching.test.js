import {
  planMatchesSpec,
  findExistingPlan,
  findMismatchedPlans,
  PLAN_NAME,
} from "../../scripts/lib/catalogue";

const SPEC = { productId: "PROD-1", price: "6.00", currency: "USD" };

const cycle = (over = {}) => ({
  tenure_type: "TRIAL", sequence: 1, total_cycles: 1,
  frequency: { interval_unit: "DAY", interval_count: 13 },
  pricing_scheme: { fixed_price: { value: "0.00", currency_code: "USD" } },
  ...over,
});
const regular = (over = {}) => ({
  tenure_type: "REGULAR", sequence: 2, total_cycles: 0,
  frequency: { interval_unit: "MONTH", interval_count: 1 },
  pricing_scheme: { fixed_price: { value: "6.00", currency_code: "USD" } },
  ...over,
});
const good = { id: "P-GOOD", name: PLAN_NAME, status: "ACTIVE", product_id: "PROD-1",
               billing_cycles: [cycle(), regular()] };

describe("a plan is reusable only when its terms match", () => {
  it("accepts a plan whose whole shape matches", () => {
    expect(planMatchesSpec(good, SPEC)).toBe(true);
    expect(findExistingPlan([good], SPEC)).toBe(good);
  });

  it("REJECTS the trial-less plan that a name match used to accept", () => {
    // This is the plan that made `create-catalogue` report "nothing needs
    // creating" while the corrected plan was never made.
    const trialless = { ...good, id: "P-OLD", billing_cycles: [regular({ sequence: 1 })] };
    expect(planMatchesSpec(trialless, SPEC)).toBe(false);
    expect(findExistingPlan([trialless], SPEC)).toBeNull();
    expect(findMismatchedPlans([trialless], SPEC).map((p) => p.id)).toEqual(["P-OLD"]);
  });

  it("rejects a different price", () => {
    expect(planMatchesSpec({ ...good, billing_cycles: [cycle(), regular({
      pricing_scheme: { fixed_price: { value: "4.99", currency_code: "USD" } } })] }, SPEC)).toBe(false);
  });

  it("rejects a different currency", () => {
    expect(planMatchesSpec({ ...good, billing_cycles: [cycle(), regular({
      pricing_scheme: { fixed_price: { value: "6.00", currency_code: "EUR" } } })] }, SPEC)).toBe(false);
  });

  it("rejects a different trial length", () => {
    expect(planMatchesSpec({ ...good, billing_cycles: [
      cycle({ frequency: { interval_unit: "DAY", interval_count: 7 } }), regular()] }, SPEC)).toBe(false);
  });

  it("rejects a repeating trial", () => {
    expect(planMatchesSpec({ ...good, billing_cycles: [cycle({ total_cycles: 3 }), regular()] }, SPEC)).toBe(false);
  });

  it("rejects a finite regular cycle, which would silently end subscriptions", () => {
    expect(planMatchesSpec({ ...good, billing_cycles: [cycle(), regular({ total_cycles: 12 })] }, SPEC)).toBe(false);
  });

  it("rejects a plan under a different product", () => {
    expect(planMatchesSpec({ ...good, product_id: "PROD-OTHER" }, SPEC)).toBe(false);
  });

  it("rejects an inactive plan", () => {
    expect(planMatchesSpec({ ...good, status: "INACTIVE" }, SPEC)).toBe(false);
  });

  it("a matching name alone is never sufficient", () => {
    const nameOnly = { id: "P-NAME", name: PLAN_NAME, status: "ACTIVE",
                       product_id: "PROD-1", billing_cycles: [] };
    expect(planMatchesSpec(nameOnly, SPEC)).toBe(false);
    expect(findExistingPlan([nameOnly], SPEC)).toBeNull();
  });

  it("mismatched plans are reported but never selected", () => {
    const found = findExistingPlan([{ ...good, id: "P-OLD", billing_cycles: [regular({ sequence: 1 })] }, good], SPEC);
    expect(found.id).toBe("P-GOOD");
  });
});
