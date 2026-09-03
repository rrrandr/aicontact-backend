import mongoose from "mongoose";

// Replay protection. Both providers retry on anything but a 2xx, so a
// duplicate must be recognised and acknowledged rather than reprocessed.
const webhookEventSchema = new mongoose.Schema({
  provider: { type: String, enum: ["apple", "paypal"], required: true },
  event_id: { type: String, required: true },
  event_type: String,
  received_at: { type: Date, default: Date.now },
  // Set when a processor takes the event, cleared if processing fails, so a
  // provider retry can pick it up again.
  processing_started_at: Date,
  // Identifies the current holder; every settle or release must present it.
  lease_token: String,
  attempts: { type: Number, default: 0 },
  last_error: String,
  processed_at: Date,
  outcome: String,
});

webhookEventSchema.index({ provider: 1, event_id: 1 }, { unique: true });

export const WebhookEvent = mongoose.model("webhook_event", webhookEventSchema);
