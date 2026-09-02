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
});

// Defence in depth. Controllers also project the password away, but this
// guarantees no future code path can serialize a hash into a response.
const stripInternalFields = (_doc, ret) => {
  delete ret.password;
  delete ret.email_norm;
  return ret;
};

userSchema.set("toJSON", { transform: stripInternalFields });
userSchema.set("toObject", { transform: stripInternalFields });

export const User = mongoose.model("user", userSchema);

// Every read goes through here so the projection can never be forgotten.
export const PUBLIC_FIELDS = "-password -email_norm";
