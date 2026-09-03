/**
 * The last thing standing between a test run and a real cancellation.
 *
 * Jest keeps going after a failure, so an earlier test passing proves nothing
 * about the state of the world by the time the destructive step runs. This
 * check therefore takes a fresh read of the subscription and re-verifies
 * every identifying fact against the state file, immediately before the call
 * that cancels. It assumes nothing that happened before it.
 *
 * Every failure is a separate, named reason so a refusal says which fact did
 * not hold.
 */

export class CancellationRefused extends Error {}

export const SANDBOX_HOST = "https://api-m.sandbox.paypal.com";

const refuse = (reason) => {
  throw new CancellationRefused(reason);
};

export const assertSafeToCancel = ({ remote, state = {}, env = process.env, host } = {}) => {
  // 1. Explicitly armed. Absent this, nothing destructive runs at all.
  if (env.PAYPAL_ALLOW_SANDBOX_CANCELLATION !== "true") {
    refuse(
      "PAYPAL_ALLOW_SANDBOX_CANCELLATION is not exactly \"true\"; refusing to cancel."
    );
  }

  // 2. Sandbox, by environment and by the host actually being talked to.
  if (env.PAYPAL_ENV !== "sandbox") {
    refuse(`PAYPAL_ENV must be exactly "sandbox", got "${env.PAYPAL_ENV || "(unset)"}".`);
  }
  if (host !== SANDBOX_HOST) {
    refuse(`Refusing to cancel against host "${host || "(none)"}"; expected ${SANDBOX_HOST}.`);
  }

  // 3. There is something to check against.
  if (!remote || typeof remote !== "object") {
    refuse("No subscription was read back from PayPal; refusing to cancel blind.");
  }
  for (const key of ["subscription_id", "plan_id", "subject_id"]) {
    if (!state[key]) refuse(`State file has no ${key}; refusing to cancel.`);
  }

  // 4. The subscription in front of us is exactly the one on record.
  if (remote.id !== state.subscription_id) {
    refuse("Subscription id from PayPal does not match the state file.");
  }
  if (remote.plan_id !== state.plan_id) {
    refuse("Plan id from PayPal does not match the state file.");
  }
  if (remote.custom_id !== state.subject_id) {
    refuse("custom_id from PayPal does not match the subject in the state file.");
  }

  // 5. Only an active subscription is a valid cancellation target.
  if (remote.status !== "ACTIVE") {
    refuse(`Subscription status is "${remote.status}", not ACTIVE; refusing to cancel.`);
  }

  return true;
};

export const cancellationArmed = (env = process.env) =>
  env.PAYPAL_ALLOW_SANDBOX_CANCELLATION === "true";
