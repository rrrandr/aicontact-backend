/**
 * Pure pieces of sandbox catalogue creation, separated so the guards and
 * payloads can be tested without touching PayPal.
 */

export const PRODUCT_NAME = "AICONTACT";
export const PLAN_NAME = "AICONTACT Monthly";

// Stable request ids give PayPal its own idempotency: replaying a create with
// the same id returns the original resource instead of a second one.
export const PRODUCT_REQUEST_ID = "aicontact-sandbox-product-v1";
// Bumped because the payload now carries the trial cycle: reusing the old id
// would return PayPal's original trial-less plan instead of creating this one.
export const PLAN_REQUEST_ID = "aicontact-sandbox-plan-trial-monthly-v1";

// Mirrors the live AICONTACT plan: one free 13-day cycle, then monthly forever.
export const TRIAL_INTERVAL_UNIT = "DAY";
export const TRIAL_INTERVAL_COUNT = 13;

export class UnsafeEnvironment extends Error {}

/**
 * Refuses anything but sandbox. This script creates resources, so the check
 * is a hard failure rather than a warning.
 */
export const assertSandbox = (env = process.env) => {
  if (env.PAYPAL_ENV !== "sandbox") {
    throw new UnsafeEnvironment(
      `Refusing to create anything: PAYPAL_ENV must be exactly "sandbox", got "${env.PAYPAL_ENV || "(unset)"}".`
    );
  }
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter((k) => !env[k]);
  if (missing.length) {
    throw new UnsafeEnvironment(`Missing from .env.sandbox: ${missing.join(", ")}`);
  }
  return true;
};

export const productPayload = () => ({
  name: PRODUCT_NAME,
  description: "AICONTACT eye-contact correction subscription",
  type: "SERVICE",
  category: "SOFTWARE",
});

export const planPayload = (productId, { price, currency }) => {
  if (!productId) throw new Error("planPayload requires a product id");
  if (!/^\d+\.\d{2}$/.test(String(price))) {
    throw new Error(`price must look like "4.99", got "${price}"`);
  }
  if (!/^[A-Z]{3}$/.test(String(currency))) {
    throw new Error(`currency must be a 3-letter code, got "${currency}"`);
  }

  return {
    product_id: productId,
    name: PLAN_NAME,
    description: "AICONTACT: 13-day free trial, then monthly until cancelled",
    status: "ACTIVE",
    // Order matters to PayPal: the trial must be sequence 1 so the paid cycle
    // follows it. The subscriber approves this whole schedule once, which is
    // what lets the trial convert to billing without asking again.
    billing_cycles: [
      {
        frequency: {
          interval_unit: TRIAL_INTERVAL_UNIT,
          interval_count: TRIAL_INTERVAL_COUNT,
        },
        tenure_type: "TRIAL",
        sequence: 1,
        // Exactly one trial cycle; it must not repeat.
        total_cycles: 1,
        pricing_scheme: {
          fixed_price: { value: "0.00", currency_code: String(currency) },
        },
      },
      {
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 2,
        // 0 = renews until cancelled.
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: { value: String(price), currency_code: String(currency) },
        },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 3,
    },
  };
};

export const findExistingProduct = (products = []) =>
  products.find(
    (p) => p.name === PRODUCT_NAME || /^aicontact$/i.test(String(p.name || "").trim())
  ) || null;

/**
 * Whether an existing plan really is the plan we want.
 *
 * Matching on name alone is what let the old trial-less plan satisfy a re-run:
 * the script reported "nothing needs creating" and the corrected plan was never
 * made. A plan is only reusable if the terms a subscriber is committing to are
 * the same ones, so compare the whole shape.
 */
export const planMatchesSpec = (plan, { productId, price, currency }) => {
  if (!plan || plan.status !== "ACTIVE") return false;
  if (productId && plan.product_id !== productId) return false;

  const cycles = plan.billing_cycles || [];
  if (cycles.length !== 2) return false;

  const trial = cycles.find((c) => c.tenure_type === "TRIAL");
  const regular = cycles.find((c) => c.tenure_type === "REGULAR");
  if (!trial || !regular) return false;

  const money = (c) => c.pricing_scheme?.fixed_price || {};

  const trialOk =
    trial.sequence === 1 &&
    Number(trial.total_cycles) === 1 &&
    trial.frequency?.interval_unit === TRIAL_INTERVAL_UNIT &&
    Number(trial.frequency?.interval_count) === TRIAL_INTERVAL_COUNT &&
    Number(money(trial).value) === 0 &&
    money(trial).currency_code === currency;

  const regularOk =
    regular.sequence === 2 &&
    Number(regular.total_cycles) === 0 &&
    regular.frequency?.interval_unit === "MONTH" &&
    Number(regular.frequency?.interval_count) === 1 &&
    Number(money(regular).value) === Number(price) &&
    money(regular).currency_code === currency;

  return trialOk && regularOk;
};

/**
 * Returns a reusable plan, or null. A plan whose name matches but whose terms
 * do not is never returned and is never modified: changing the terms of a plan
 * people are already subscribed to is not something a setup script should do.
 */
export const findExistingPlan = (plans = [], spec = {}) => {
  const productId = typeof spec === "string" ? spec : spec.productId;
  const full = typeof spec === "string" ? { productId } : spec;
  if (!full.price || !full.currency) return null;
  return plans.find((p) => planMatchesSpec(p, { ...full, productId })) || null;
};

/** Plans that look like ours by name but do not match the terms we require. */
export const findMismatchedPlans = (plans = [], spec = {}) =>
  plans.filter(
    (p) =>
      (p.name === PLAN_NAME || /aicontact/i.test(String(p.name || ""))) &&
      !planMatchesSpec(p, spec)
  );
