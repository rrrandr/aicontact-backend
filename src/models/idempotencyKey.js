import mongoose from "mongoose";

const idempotencyKeySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  endpoint: String,
  // Guards against a key being reused for a different request.
  request_hash: String,
  status_code: Number,
  response_body: mongoose.Schema.Types.Mixed,
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, index: { expires: 0 } },
});

export const IdempotencyKey = mongoose.model(
  "idempotency_key",
  idempotencyKeySchema
);
