import mongoose from "mongoose";

/**
 * Revocation state for a whole refresh-token lineage.
 *
 * Individual token rows are not enough. A rotation that stalls can insert its
 * successor *after* the family has been revoked, resurrecting a session that
 * was deliberately ended. Recording revocation against the family - and
 * checking it on every rotation - makes any such row inert regardless of when
 * it lands.
 *
 * This is the durable state that a multi-document transaction would otherwise
 * provide; the production deployment is a standalone mongod, so transactions
 * are not available.
 */
const tokenFamilySchema = new mongoose.Schema({
  family_id: { type: String, required: true, unique: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },
  // The account's credential generation when this family was created. A
  // family that no longer matches User.token_version belongs to a superseded
  // generation and must not be able to mint access tokens under the new one.
  token_version: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  revoked_at: Date,
  reason: String,
});

export const TokenFamily = mongoose.model("token_family", tokenFamilySchema);
