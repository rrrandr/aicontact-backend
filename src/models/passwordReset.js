import mongoose from "mongoose";

// Single use, short lived, and stored only as a hash - the same treatment as
// a refresh token, because it grants the same thing.
const passwordResetSchema = new mongoose.Schema({
  token_hash: { type: String, required: true, unique: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },
  // The account's credential generation when this link was issued. Any
  // successful reset moves the account past it, which is what invalidates
  // every sibling link - without inferring ordering from millisecond
  // timestamps.
  token_version_at_issue: Number,
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, required: true, index: { expires: 0 } },
  // Held while the code is being acted on, cleared if that work fails, so a
  // transient error does not spend the code.
  processing_started_at: Date,
  // Identifies the current holder; every settle or release must present it.
  lease_token: String,
  used_at: Date,
});

export const PasswordReset = mongoose.model("password_reset", passwordResetSchema);
