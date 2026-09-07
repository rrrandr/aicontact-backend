import mongoose from "mongoose";

/**
 * One row per PayPal subscription, bound to exactly one account.
 *
 * The unique constraint is the fix for the desktop client's entitlement model,
 * where any 14-character subscription ID unlocked any installation and
 * subscription IDs are not secret.
 */
const paypalSubscriptionSchema = new mongoose.Schema({
  subscription_id: { type: String, required: true, unique: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },

  plan_id: String,
  status: String,
  next_billing_time: Date,

  // "trial" while the plan's trial cycle is still running, "paid" afterwards.
  // Read from PayPal's own cycle bookkeeping, never inferred from dates.
  phase: { type: String, enum: ["trial", "paid", "unknown"], default: "unknown" },

  // Set once, the first time PayPal reports the subscription ACTIVE. This is
  // the durable record of an approval, which is what the weekly owner tally
  // counts; the row itself is created when the subscribe request is made,
  // which is not the same event.
  activated_at: Date,

  // Set once, when a cancellation is confirmed by PayPal. Re-deriving these on
  // a second attempt would overwrite access_ends_at with a null next billing
  // time, so every writer guards on cancelled_at not already existing.
  cancelled_at: Date,
  cancellation_source: {
    type: String,
    enum: ["user", "account_deletion", "provider"],
  },
  access_ends_at: Date,
  // True when ownership was proved through the migration path rather than
  // by a binding the server created.
  legacy_claim: { type: Boolean, default: false },
  linked_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

export const PaypalSubscription = mongoose.model(
  "paypal_subscription",
  paypalSubscriptionSchema
);
