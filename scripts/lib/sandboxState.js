import fs from "fs";
import path from "path";

export const STATE_FILE = path.join(process.cwd(), ".paypal-sandbox-state.json");

export const readState = (file = STATE_FILE) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

export const writeState = (patch, file = STATE_FILE) => {
  fs.writeFileSync(file, JSON.stringify({ ...readState(file), ...patch }, null, 2) + "\n");
};

export class SubscriptionMismatch extends Error {}

/**
 * Which subscription phase 2 should act on.
 *
 * Phase 1 already records the id it created, so requiring it to be copied
 * into the environment by hand is a step that can only introduce a mistake.
 * The state file is therefore the default source; the environment variable
 * remains available as a deliberate override.
 *
 * When both are present and disagree, that is not something to resolve by
 * precedence - it means the run is about to act on a different subscription
 * than the one recorded, so it stops.
 */
export const resolveSubscriptionId = ({ envValue, state = {} } = {}) => {
  const fromEnv = typeof envValue === "string" ? envValue.trim() : "";
  const fromState =
    typeof state.subscription_id === "string" ? state.subscription_id.trim() : "";

  if (fromEnv && fromState && fromEnv !== fromState) {
    throw new SubscriptionMismatch(
      `PAYPAL_TEST_SUBSCRIPTION_ID does not match the subscription recorded in ` +
        `.paypal-sandbox-state.json. Clear the environment override, or delete the ` +
        `state file if you intend to work with a different subscription.`
    );
  }

  return fromEnv || fromState || null;
};

/** Where the override came from, for reporting. */
export const subscriptionSource = ({ envValue, state = {} } = {}) => {
  const fromEnv = typeof envValue === "string" ? envValue.trim() : "";
  if (fromEnv) return "environment override";
  if (state.subscription_id) return "state file";
  return "none";
};
