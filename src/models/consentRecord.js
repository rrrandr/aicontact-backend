import mongoose from "mongoose";

/**
 * A durable record that a person accepted a specific version of a specific
 * document.
 *
 * This exists because acceptance used to be a string in PlayerPrefs on the
 * user's own machine, which is not evidence of anything: they control it and a
 * reinstall clears it. Every term worth having - the arbitration clause, the
 * liability cap, the camera acknowledgement - depends on being able to show
 * what someone agreed to and when.
 *
 * Deliberately holds no IP address, no hash of one, and no User-Agent. The
 * account is already identified; the request's network origin adds nothing to
 * the proof and would be personal data we have no stated need for.
 */
const consentRecordSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },
  // Retained through account deletion so the acceptance survives the person,
  // the same way the financial records do.
  subject_id: { type: String, index: true },

  document: {
    type: String,
    enum: ["terms", "privacy", "camera", "age_attestation"],
    required: true,
  },
  version: { type: String, required: true },

  // For an attestation, the exact sentence the person was shown. A record that
  // someone ticked a box is worth little without the wording of the box.
  statement: String,

  client_version: String,
  platform: String,
  accepted_at: { type: Date, default: Date.now, index: true },
  // Set when an acknowledgement is withdrawn rather than deleting the row:
  // that this person once consented, and then stopped, is itself the record.
  withdrawn_at: Date,
});

// One row per account per document version. A repeated submission of the same
// acceptance is the same fact, not a second one.
consentRecordSchema.index(
  { user_id: 1, document: 1, version: 1 },
  { unique: true, partialFilterExpression: { user_id: { $exists: true } } }
);

export const ConsentRecord = mongoose.model("consent_record", consentRecordSchema);
