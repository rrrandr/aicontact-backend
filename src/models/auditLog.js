import mongoose from "mongoose";

// Entitlement grants, deletions and credential changes.
//
// Deliberately records no IP address and no hash of one. A hashed address is
// still information about a person and the address space is small enough to
// reverse by brute force; no process here reads one, so there is nothing to
// weigh it against. The account, the action and the time are the record.
const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true, index: true },
  subject_id: { type: String, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  detail: mongoose.Schema.Types.Mixed,
  at: { type: Date, default: Date.now, index: true },
});

export const AuditLog = mongoose.model("audit_log", auditLogSchema);
