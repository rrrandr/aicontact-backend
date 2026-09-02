import mongoose from "mongoose";

/**
 * A pending attempt to claim a PayPal subscription that pre-dates
 * server-side account binding.
 *
 * Ownership is proved by a code delivered to the address PayPal holds for the
 * subscriber - not one the caller supplied - so possession of a subscription
 * id is not sufficient.
 */
const paypalLegacyClaimSchema = new mongoose.Schema({
  subscription_id: { type: String, required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },
  code_hash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, required: true, index: { expires: 0 } },
  // Held while the code is being acted on, cleared if that work fails, so a
  // transient error does not spend the code.
  processing_started_at: Date,
  consumed_at: Date,
});

paypalLegacyClaimSchema.index({ subscription_id: 1, user_id: 1 }, { unique: true });

export const PaypalLegacyClaim = mongoose.model(
  "paypal_legacy_claim",
  paypalLegacyClaimSchema
);
