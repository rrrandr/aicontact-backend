import mongoose from "mongoose";

/**
 * One row per weekly reporting window.
 *
 * The unique key is the window itself, which is what makes delivery
 * idempotent: a retry, a second process, or a restart all compute the same
 * window and therefore collide on the same row rather than sending a second
 * copy of the same summary.
 *
 * A report that could not be delivered is kept, not discarded, so the next
 * attempt sends the week that was missed rather than silently skipping it.
 */
const weeklyReportSchema = new mongoose.Schema({
  period_start: { type: Date, required: true },
  period_end: { type: Date, required: true },

  // Counts only. No addresses, no identifiers, nothing that would make this
  // summary something to be careful with.
  counts: mongoose.Schema.Types.Mixed,

  status: {
    type: String,
    enum: ["pending", "sending", "sent", "failed"],
    default: "pending",
    index: true,
  },
  // Identifies the current sender; every settle presents it, so a process
  // whose lease went stale cannot mark its successor's work delivered.
  lease_token: String,
  sending_started_at: Date,

  attempts: { type: Number, default: 0 },
  last_error: String,
  generated_at: { type: Date, default: Date.now },
  sent_at: Date,
});

weeklyReportSchema.index({ period_start: 1, period_end: 1 }, { unique: true });

export const WeeklyReport = mongoose.model("weekly_report", weeklyReportSchema);
