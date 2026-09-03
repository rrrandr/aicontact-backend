const { redact } = require("../src/util/redact");

/**
 * Opt-in, and closed by default.
 *
 * Absent the opt-in flag the suite does not run at all. Present but
 * misconfigured, it FAILS rather than skipping - a sandbox suite that quietly
 * reports success because its credentials were missing is worse than one that
 * never ran.
 */
const REQUIRED = [
  "PAYPAL_ENV",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_PLAN_IDS",
  "PAYPAL_RETURN_URL",
  "PAYPAL_CANCEL_URL",
];

const enabled = () => process.env.PAYPAL_SANDBOX_INTEGRATION === "1";

const missing = () => REQUIRED.filter((key) => !process.env[key]);

const assertConfigured = () => {
  if (process.env.PAYPAL_ENV !== "sandbox") {
    throw new Error(
      `PAYPAL_ENV must be exactly "sandbox", got "${process.env.PAYPAL_ENV || "(unset)"}". ` +
        `This suite will not run against Live.`
    );
  }
  const absent = missing();
  if (absent.length) {
    throw new Error(
      `Sandbox integration is enabled but these are missing from .env.sandbox: ${absent.join(", ")}`
    );
  }
};

/** describe() that skips wholesale when opt-in is off, and fails when on but unusable. */
const describeSandbox = (name, body) => {
  if (!enabled()) {
    // eslint-disable-next-line jest/no-disabled-tests
    describe.skip(`${name} [set PAYPAL_SANDBOX_INTEGRATION=1 to run]`, () => {
      it("skipped", () => {});
    });
    return;
  }

  describe(name, () => {
    it("is configured for sandbox", () => {
      expect(() => assertConfigured()).not.toThrow();
    });
    body();
  });
};

const log = (...parts) => {
  // eslint-disable-next-line no-console
  console.log(parts.map((p) => redact(typeof p === "string" ? p : JSON.stringify(p, null, 2))).join(" "));
};

module.exports = { describeSandbox, assertConfigured, enabled, missing, log, REQUIRED };
