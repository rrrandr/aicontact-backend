import mongoose from "mongoose";

// PATCH /api/user/update is unauthenticated and cannot be closed without
// breaking released clients, so until v2 retires it we at least record every
// entitlement write. This makes the abuse measurable rather than invisible.
const entitlementAuditSchema = new mongoose.Schema({
  email_norm: { type: String, index: true },
  previous_subscription_date: String,
  next_subscription_date: String,
  ip: String,
  user_agent: String,
  at: { type: Date, default: Date.now, index: true },
});

export const EntitlementAudit = mongoose.model(
  "entitlement_audit",
  entitlementAuditSchema
);
