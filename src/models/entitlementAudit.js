import mongoose from "mongoose";

// PATCH /api/user/update is unauthenticated and cannot be closed without
// breaking released clients, so until v2 retires it we at least record every
// entitlement write. This makes the abuse measurable rather than invisible.
const entitlementAuditSchema = new mongoose.Schema({
  email_norm: { type: String, index: true },
  previous_subscription_date: String,
  next_subscription_date: String,
  // True when the write was ignored because the account has a server-owned
  // entitlement (V1_ENTITLEMENT_READONLY).
  ignored: { type: Boolean, default: false },
  // No ip or user_agent. This row exists to measure abuse of an
  // unauthenticated endpoint; the normalised address already identifies the
  // account involved, and nothing reads a network origin.
  at: { type: Date, default: Date.now, index: true },
});

export const EntitlementAudit = mongoose.model(
  "entitlement_audit",
  entitlementAuditSchema
);
