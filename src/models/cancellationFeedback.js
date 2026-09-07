import mongoose from "mongoose";

/**
 * Why someone cancelled, when they chose to say.
 *
 * Separate from the cancellation itself on purpose: the cancellation must
 * succeed and be recorded whether or not this row is ever written, and nothing
 * in the billing path reads it. One row per cancellation, so a second
 * submission corrects the first rather than accumulating duplicates.
 */
const cancellationFeedbackSchema = new mongoose.Schema({
  // Keyed by the pseudonymous identifier, so the answer survives account
  // deletion without retaining the person.
  subject_id: { type: String, required: true, unique: true },
  reason_code: String,
  // Free text is optional and capped. Nothing here is shown to anyone but the
  // owner, and it is never included in the weekly tally.
  comment: String,
  at: { type: Date, default: Date.now, index: true },
});

export const CancellationFeedback = mongoose.model(
  "cancellation_feedback",
  cancellationFeedbackSchema
);

// Offered in the client. "other" exists so the free-text box has a home; every
// one of them, including the code itself, is optional.
export const FEEDBACK_REASONS = [
  "too_expensive",
  "not_using_it",
  "missing_features",
  "technical_problems",
  "temporary_break",
  "other",
];

export const MAX_COMMENT_LENGTH = 1000;
