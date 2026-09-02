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
  linked_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

export const PaypalSubscription = mongoose.model(
  "paypal_subscription",
  paypalSubscriptionSchema
);
