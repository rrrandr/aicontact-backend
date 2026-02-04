import mongoose from "mongoose";

const Schema = mongoose.Schema;

const userSchema = new Schema({
  email: {
    type: String,
    unique: true,
    match: [
      /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
      "Please fill a valid email address",
    ],
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  subscription_date: {
    type: String,
    required: false,
    default: ""
  },
  terms_accepted: {
    type: String,
    default: "false",
  }
},
);

export const User = mongoose.model("user", userSchema);
