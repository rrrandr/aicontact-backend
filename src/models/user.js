import mongoose from "mongoose";
import { isValidEmail } from "../util/email";

const Schema = mongoose.Schema;

const userSchema = new Schema({
  email: {
    type: String,
    unique: true,
    required: true,
    validate: {
      validator: isValidEmail,
      message: "Please fill a valid email address",
    },
  },
  // Added alongside `email`, never replacing it. Existing rows keep their
  // stored casing untouched, so this migration is reversible without a data
  // restore. Lookups fall back to an exact match until the backfill has run.
  email_norm: {
    type: String,
    index: true,
    sparse: true,
  },
  password: {
    type: String,
    required: true,
  },
  subscription_date: {
    type: String,
    required: false,
    default: "",
  },
  terms_accepted: {
    type: String,
    default: "false",
  },

  // ---- v2 fields ----
  // All of these are stripped from serialization below so that v1 response
  // bodies stay byte-identical; v2 builds its own DTOs explicitly.

  // Stable pseudonymous identifier. Survives account deletion so financial
  // records can be retained without retaining the person.
  subject_id: { type: String, index: true, sparse: true },

  // Incremented to invalidate every issued access token at once - on password
  // reset, on deletion, on demand.
  token_version: { type: Number, default: 0 },

  password_updated_at: Date,
  // Which reset token last changed this password. Written in the SAME
  // document update as the password itself, so the irreversible change and
  // the record of the code being spent cannot diverge - whatever happens to
  // the reset record afterwards.
  password_reset_token_hash: String,
  terms_accepted_at: Date,

  status: {
    type: String,
    enum: ["active", "deleted"],
    default: "active",
    index: true,
  },
  deleted_at: Date,
});

userSchema.index({ status: 1, email_norm: 1 });

// Defence in depth. Controllers also project the password away, but this
// guarantees no future code path can serialize a hash into a response.
const INTERNAL_FIELDS = [
  "password",
  "email_norm",
  "subject_id",
  "token_version",
  "password_updated_at",
  "password_reset_token_hash",
  "terms_accepted_at",
  "status",
  "deleted_at",
];

const stripInternalFields = (_doc, ret) => {
  for (const field of INTERNAL_FIELDS) delete ret[field];
  return ret;
};

userSchema.set("toJSON", { transform: stripInternalFields });
userSchema.set("toObject", { transform: stripInternalFields });

export const User = mongoose.model("user", userSchema);

// Every v1 read goes through here so the projection can never be forgotten.
export const PUBLIC_FIELDS = INTERNAL_FIELDS.map((f) => `-${f}`).join(" ");
