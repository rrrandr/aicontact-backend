import {
  assertSafeToCancel,
  cancellationArmed,
  CancellationRefused,
  SANDBOX_HOST,
} from "../../scripts/lib/cancellationGuard";

const state = {
  subscription_id: "I-SUB0001",
  plan_id: "P-PLAN001",
  subject_id: "sub_abc123",
};

const remote = {
  id: "I-SUB0001",
  plan_id: "P-PLAN001",
  custom_id: "sub_abc123",
  status: "ACTIVE",
};

const env = {
  PAYPAL_ALLOW_SANDBOX_CANCELLATION: "true",
  PAYPAL_ENV: "sandbox",
};

const call = (overrides = {}) =>
  assertSafeToCancel({ remote, state, env, host: SANDBOX_HOST, ...overrides });

describe("cancellation guard", () => {
  it("permits cancellation when every fact lines up", () => {
    expect(call()).toBe(true);
  });

  describe("arming", () => {
    it("refuses unless explicitly armed", () => {
      expect(() => call({ env: { ...env, PAYPAL_ALLOW_SANDBOX_CANCELLATION: undefined } })).toThrow(
        CancellationRefused
      );
      expect(() => call({ env: { ...env, PAYPAL_ALLOW_SANDBOX_CANCELLATION: "false" } })).toThrow(
        /not exactly/
      );
    });

    it("does not accept near-misses for the flag", () => {
      // "1", "yes" and "TRUE" are the values someone reaches for in a hurry.
      for (const value of ["1", "yes", "TRUE", "True", " true"]) {
        expect(() =>
          call({ env: { ...env, PAYPAL_ALLOW_SANDBOX_CANCELLATION: value } })
        ).toThrow(CancellationRefused);
      }
    });

    it("reports whether it is armed", () => {
      expect(cancellationArmed(env)).toBe(true);
      expect(cancellationArmed({ PAYPAL_ALLOW_SANDBOX_CANCELLATION: "1" })).toBe(false);
      expect(cancellationArmed({})).toBe(false);
    });
  });

  describe("environment", () => {
    it("refuses outside sandbox", () => {
      expect(() => call({ env: { ...env, PAYPAL_ENV: "live" } })).toThrow(/must be exactly "sandbox"/);
      expect(() => call({ env: { ...env, PAYPAL_ENV: undefined } })).toThrow(/unset/);
    });

    it("refuses against any host other than the sandbox one", () => {
      expect(() => call({ host: "https://api-m.paypal.com" })).toThrow(/Refusing to cancel against host/);
      expect(() => call({ host: undefined })).toThrow(/expected/);
    });
  });

  describe("identity", () => {
    it("refuses when the subscription id differs", () => {
      expect(() => call({ remote: { ...remote, id: "I-SOMETHINGELSE" } })).toThrow(
        /Subscription id from PayPal does not match/
      );
    });

    it("refuses when the plan differs", () => {
      expect(() => call({ remote: { ...remote, plan_id: "P-OTHER" } })).toThrow(/Plan id/);
    });

    it("refuses when custom_id does not match the recorded subject", () => {
      expect(() => call({ remote: { ...remote, custom_id: "sub_someone_else" } })).toThrow(
        /custom_id/
      );
    });

    it("refuses when custom_id is absent entirely", () => {
      const { custom_id, ...withoutCustomId } = remote;
      expect(() => call({ remote: withoutCustomId })).toThrow(/custom_id/);
    });
  });

  describe("status", () => {
    it("refuses anything that is not ACTIVE", () => {
      for (const status of ["APPROVAL_PENDING", "SUSPENDED", "CANCELLED", "EXPIRED", undefined]) {
        expect(() => call({ remote: { ...remote, status } })).toThrow(/not ACTIVE/);
      }
    });
  });

  describe("missing inputs", () => {
    it("refuses to cancel blind", () => {
      expect(() => call({ remote: null })).toThrow(/refusing to cancel blind/);
      expect(() => call({ remote: undefined })).toThrow(/refusing to cancel blind/);
    });

    it("refuses when the state file is incomplete", () => {
      for (const key of ["subscription_id", "plan_id", "subject_id"]) {
        const partial = { ...state };
        delete partial[key];
        expect(() => call({ state: partial })).toThrow(new RegExp(`no ${key}`));
      }
    });
  });

  it("checks arming before anything else, so a disarmed run reveals nothing", () => {
    // Ordering matters: a disarmed run should say it is disarmed, not leak
    // which other fact happened to be wrong.
    expect(() =>
      assertSafeToCancel({
        remote: { ...remote, id: "I-WRONG", status: "CANCELLED" },
        state,
        env: { ...env, PAYPAL_ALLOW_SANDBOX_CANCELLATION: "false" },
        host: "https://api-m.paypal.com",
      })
    ).toThrow(/not exactly "true"/);
  });
});
