/**
 * A sandbox entitlement recorded as "Production" is indistinguishable from real
 * billing data. It was observed live in the sandbox run before this fix.
 */
const withEnv = (value, fn) => {
  const saved = process.env.PAYPAL_ENV;
  process.env.PAYPAL_ENV = value;
  jest.resetModules();
  try { return fn(require("../../src/config/env")); }
  finally {
    if (saved === undefined) delete process.env.PAYPAL_ENV;
    else process.env.PAYPAL_ENV = saved;
    jest.resetModules();
  }
};

describe("entitlement environment label", () => {
  it("records sandbox as Sandbox", () => {
    withEnv("sandbox", ({ paypalEnvironmentLabel }) =>
      expect(paypalEnvironmentLabel()).toBe("Sandbox"));
  });

  it("records live as Production", () => {
    withEnv("live", ({ paypalEnvironmentLabel }) =>
      expect(paypalEnvironmentLabel()).toBe("Production"));
  });

  it("defaults to Production when unset, matching the host default", () => {
    withEnv("", ({ paypalEnvironmentLabel }) =>
      expect(paypalEnvironmentLabel()).toBe("Production"));
  });

  it("only ever returns a value the Entitlement schema permits", () => {
    for (const v of ["sandbox", "live", "", "nonsense"]) {
      withEnv(v, ({ paypalEnvironmentLabel }) =>
        expect(["Sandbox", "Production"]).toContain(paypalEnvironmentLabel()));
    }
  });
});
