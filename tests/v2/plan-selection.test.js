import { resolvePlanId, PaypalError } from "../../src/v2/services/paypalService";

/**
 * The client sends no plan. These cover what the server must then do, including
 * the case that broke in sandbox: an empty body must succeed when exactly one
 * plan is configured.
 */
const withPlans = (value, fn) => {
  const saved = process.env.PAYPAL_PLAN_IDS;
  if (value === undefined) delete process.env.PAYPAL_PLAN_IDS;
  else process.env.PAYPAL_PLAN_IDS = value;
  jest.resetModules();
  try { return fn(require("../../src/v2/services/paypalService")); }
  finally {
    if (saved === undefined) delete process.env.PAYPAL_PLAN_IDS;
    else process.env.PAYPAL_PLAN_IDS = saved;
    jest.resetModules();
  }
};

describe("server-side plan selection", () => {
  it("selects the sole configured plan when the client sends nothing", () => {
    withPlans("P-ONLYONE", ({ resolvePlanId }) => {
      expect(resolvePlanId(undefined)).toBe("P-ONLYONE");
      expect(resolvePlanId(null)).toBe("P-ONLYONE");
      expect(resolvePlanId("")).toBe("P-ONLYONE");
    });
  });

  it("still honours an explicit plan id that is on the allowlist", () => {
    withPlans("P-ONE,P-TWO", ({ resolvePlanId }) => {
      expect(resolvePlanId("P-TWO")).toBe("P-TWO");
    });
  });

  it("requires an explicit plan when several are configured", () => {
    withPlans("P-ONE,P-TWO", ({ resolvePlanId }) => {
      expect(() => resolvePlanId(undefined)).toThrow(/plan_id is required/);
      try { resolvePlanId(undefined); } catch (e) {
        expect(e.code).toBe("paypal_plan_id_required");
        expect(e.statusCode).toBe(400);
      }
    });
  });

  it("fails as configuration, not user error, when no plan is configured", () => {
    withPlans("", ({ resolvePlanId }) => {
      try { resolvePlanId(undefined); throw new Error("should have thrown"); }
      catch (e) {
        expect(e.code).toBe("paypal_no_plan_configured");
        expect(e.statusCode).toBe(500);
      }
    });
  });

  it("refuses an unknown plan even when one is configured", () => {
    withPlans("P-ONLYONE", ({ resolvePlanId }) => {
      try { resolvePlanId("P-2VE89484US257061NMXXK2TY"); throw new Error("should have thrown"); }
      catch (e) { expect(e.code).toBe("paypal_unknown_plan"); }
    });
  });

  it("refuses a non-string plan id rather than coercing it", () => {
    withPlans("P-ONLYONE", ({ resolvePlanId }) => {
      expect(() => resolvePlanId(42)).toThrow();
      expect(() => resolvePlanId({})).toThrow();
    });
  });
});
