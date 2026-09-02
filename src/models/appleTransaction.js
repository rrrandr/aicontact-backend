import mongoose from "mongoose";

/**
 * One row per Apple subscription lineage.
 *
 * original_transaction_id is unique, which is what stops a single purchase
 * from being presented against several accounts.
 */
const appleTransactionSchema = new mongoose.Schema({
  original_transaction_id: { type: String, required: true, unique: true },
  transaction_id: String,
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },

  product_id: String,
  purchase_date: Date,
  expires_date: Date,
  revocation_date: Date,
  revocation_reason: Number,

  environment: { type: String, enum: ["Production", "Sandbox"] },
  last_notification_uuid: String,
  updated_at: { type: Date, default: Date.now },
});

export const AppleTransaction = mongoose.model(
  "apple_transaction",
  appleTransactionSchema
);
