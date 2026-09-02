import mongoose from "mongoose";

// Entitlement grants, deletions and credential changes. Deliberately records
// a hash of the source address rather than the address itself.
const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true, index: true },
  subject_id: { type: String, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  detail: mongoose.Schema.Types.Mixed,
  ip_hash: String,
  at: { type: Date, default: Date.now, index: true },
});

export const AuditLog = mongoose.model("audit_log", auditLogSchema);
