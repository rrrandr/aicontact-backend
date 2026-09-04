import {
  assertSandbox,
  UnsafeEnvironment,
  productPayload,
  planPayload,
  findExistingProduct,
  findExistingPlan,
  PRODUCT_NAME,
  PLAN_NAME,
} from "../../scripts/lib/catalogue";

describe("sandbox catalogue guards", () => {
  const sandboxEnv = {
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
  };

  it("refuses any environment that is not sandbox", () => {
    // This script creates resources, so anything ambiguous is a hard stop.
    expect(() => assertSandbox({ ...sandboxEnv, PAYPAL_ENV: "live" })).toThrow(UnsafeEnvironment);
    expect(() => assertSandbox({ ...sandboxEnv, PAYPAL_ENV: "" })).toThrow(/must be exactly/);
    expect(() => assertSandbox({ ...sandboxEnv, PAYPAL_ENV: "Sandbox" })).toThrow(UnsafeEnvironment);
    expect(() => assertSandbox({ ...sandboxEnv, PAYPAL_ENV: undefined })).toThrow(/unset/);
  });

  it("refuses to run without credentials", () => {
    expect(() => assertSandbox({ PAYPAL_ENV: "sandbox" })).toThrow(/Missing from .env.sandbox/);
  });

  it("accepts a correctly configured sandbox", () => {
    expect(assertSandbox(sandboxEnv)).toBe(true);
  });
});

describe("payloads", () => {
  it("describes the product the way the Live catalogue should", () => {
    expect(productPayload()).toEqual({
      name: "AICONTACT",
      description: "AICONTACT eye-contact correction subscription",
      type: "SERVICE",
      category: "SOFTWARE",
    });
  });

  it("builds a monthly plan that renews indefinitely", () => {
    const plan = planPayload("PROD-123", { price: "4.99", currency: "USD" });

    expect(plan.product_id).toBe("PROD-123");
    expect(plan.name).toBe(PLAN_NAME);
    expect(plan.status).toBe("ACTIVE");
    // Trial first, then the paid cycle. Selected by tenure rather than index so
    // this test keeps checking the monthly terms wherever it sits.
    expect(plan.billing_cycles).toHaveLength(2);

    const cycle = plan.billing_cycles.find((c) => c.tenure_type === "REGULAR");
    expect(cycle.frequency).toEqual({ interval_unit: "MONTH", interval_count: 1 });
    expect(cycle.tenure_type).toBe("REGULAR");
    // 0 means until cancelled - a finite count would silently end subscriptions.
    expect(cycle.total_cycles).toBe(0);
    expect(cycle.pricing_scheme.fixed_price).toEqual({
      value: "4.99",
      currency_code: "USD",
    });
  });

  it("matches the price shown in the released Unity client", () => {
    const plan = planPayload("PROD-123", { price: "4.99", currency: "USD" });
    const regular = plan.billing_cycles.find((c) => c.tenure_type === "REGULAR");
    expect(regular.pricing_scheme.fixed_price.value).toBe("4.99");
  });

  it("rejects a malformed price or currency rather than sending it", () => {
    expect(() => planPayload("PROD-123", { price: "4.9", currency: "USD" })).toThrow(/price/);
    expect(() => planPayload("PROD-123", { price: "", currency: "USD" })).toThrow(/price/);
    expect(() => planPayload("PROD-123", { price: "4.99", currency: "usd" })).toThrow(/currency/);
    expect(() => planPayload("PROD-123", { price: "4.99", currency: "DOLLARS" })).toThrow(/currency/);
    expect(() => planPayload(null, { price: "4.99", currency: "USD" })).toThrow(/product id/);
  });

  it("catches a number that loses its trailing zero", () => {
    // The trap with passing an amount as a number: 4.90 stringifies to "4.9",
    // which PayPal would read as a different price. 4.99 survives, so the
    // guard has to be on the rendered string rather than the type.
    expect(() => planPayload("PROD-123", { price: 4.9, currency: "USD" })).toThrow(/price/);
    expect(
      planPayload("PROD-123", { price: 4.99, currency: "USD" })
        .billing_cycles.find((c) => c.tenure_type === "REGULAR")
        .pricing_scheme.fixed_price.value
    ).toBe("4.99");
  });
});

describe("re-run safety", () => {
  it("finds an existing product rather than making a second one", () => {
    expect(findExistingProduct([{ id: "P1", name: PRODUCT_NAME }])).toEqual({
      id: "P1",
      name: PRODUCT_NAME,
    });
    expect(findExistingProduct([{ id: "P1", name: "  aicontact " }])).toBeTruthy();
    expect(findExistingProduct([{ id: "P1", name: "Something Else" }])).toBeNull();
    expect(findExistingProduct([])).toBeNull();
  });

  it("finds an existing plan by name or by product", () => {
    expect(findExistingPlan([{ id: "PL1", name: PLAN_NAME }])).toBeTruthy();
    expect(
      findExistingPlan([{ id: "PL1", name: "Monthly", product_id: "PROD-1" }], "PROD-1")
    ).toBeTruthy();
    expect(findExistingPlan([{ id: "PL1", name: "Annual", product_id: "OTHER" }], "PROD-1")).toBeNull();
    expect(findExistingPlan([])).toBeNull();
  });
});
