import mongoose from "mongoose";

/**
 * A subscription we still need PayPal to stop billing.
 *
 * Recorded when a cancellation cannot be confirmed during account deletion,
 * so the attempt survives the request that started it. Without this the only
 * record of an unstopped subscription would be a log line, and the person who
 * could have chased it no longer has an account to sign in to.
 */
const pendingCancellationSchema = new mongoose.Schema({
  provider: { type: String, default: "paypal" },
  subscription_id: { type: String, required: true, unique: true },
  // Retained rather than user_id: the account may be gone by the time this
  // resolves.
  subject_id: { type: String, index: true },
  reason: String,
  attempts: { type: Number, default: 0 },
  last_error: String,
  last_attempt_at: Date,
  created_at: { type: Date, default: Date.now },
  resolved_at: Date,
});

export const PendingCancellation = mongoose.model(
  "pending_cancellation",
  pendingCancellationSchema
);
