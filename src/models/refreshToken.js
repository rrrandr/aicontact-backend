import mongoose from "mongoose";

/**
 * Refresh tokens are opaque random values. Only their SHA-256 hash is stored,
 * so a database disclosure does not yield usable sessions.
 *
 * `family_id` links a token to its rotation lineage. Presenting a token that
 * has already been rotated means the value leaked, so the whole family is
 * revoked rather than just the one token.
 */
const refreshTokenSchema = new mongoose.Schema({
  token_hash: { type: String, required: true, unique: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },
  family_id: { type: String, required: true, index: true },

  issued_at: { type: Date, default: Date.now },
  expires_at: { type: Date, required: true, index: true },
  revoked_at: Date,
  replaced_by: String,

  user_agent: String,
  ip_hash: String,
});

export const RefreshToken = mongoose.model("refresh_token", refreshTokenSchema);
