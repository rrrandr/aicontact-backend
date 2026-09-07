import mongoose from "mongoose";
import { User } from "../../models/user";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { PendingCancellation } from "../../models/pendingCancellation";
import { WeeklyReport } from "../../models/weeklyReport";
import { weeklyWindow, REPORT_TIMEZONE } from "./reportWindow";
import { notifyOwner, destination } from "./ownerNotifier";
import { config } from "../../config/env";
import { logger } from "../../util/logger";
import { randomToken } from "../../util/crypto";

/**
 * One weekly summary for the owner, instead of a message per signup and per
 * cancellation.
 *
 * Every number comes from a durable database record, never from a log line:
 * logs rotate, are sampled, and are not a place to keep something the business
 * is counted on. Where an existing timestamp already records the event it is
 * reused rather than duplicated - registrations come from the account's own
 * identifier, deletions from users.deleted_at - and only the two moments
 * nothing recorded, approval and cancellation, needed new fields.
 */

// A subscription that will not be charged again is not an active subscriber,
// even while the period already paid for is still running.
const stillBilling = { cancelled_at: { $exists: false }, status: "ACTIVE" };

/** An ObjectId whose embedded timestamp is exactly this instant. */
const idAt = (date) =>
  mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

export const collectCounts = async ({ start, end }) => {
  const inWindow = { $gte: start, $lt: end };

  const [
    registrations,
    approvals,
    cancellations,
    deletions,
    activeTrials,
    activePaid,
    activeUnknownPhase,
    unresolvedCancellations,
    failedCancellationAttempts,
  ] = await Promise.all([
    // Accounts carry no created_at, but every _id embeds the second it was
    // created, and it survives the tombstoning that deletion applies. That is
    // a real record of the registration, so nothing new is stored for it.
    User.countDocuments({ _id: { $gte: idAt(start), $lt: idAt(end) } }),
    PaypalSubscription.countDocuments({ activated_at: inWindow }),
    PaypalSubscription.countDocuments({ cancelled_at: inWindow }),
    User.countDocuments({ deleted_at: inWindow }),

    // Current state, not window state: "how many subscribers are there now".
    PaypalSubscription.countDocuments({ ...stillBilling, phase: "trial" }),
    PaypalSubscription.countDocuments({ ...stillBilling, phase: "paid" }),
    // Subscriptions linked before the phase was recorded. Reported separately
    // rather than folded into either bucket, which would misstate both.
    PaypalSubscription.countDocuments({
      ...stillBilling,
      $or: [{ phase: "unknown" }, { phase: { $exists: false } }],
    }),

    PendingCancellation.countDocuments({ resolved_at: { $exists: false } }),
    PendingCancellation.countDocuments({
      resolved_at: { $exists: false },
      last_attempt_at: inWindow,
    }),
  ]);

  return {
    registrations,
    subscriptions_approved: approvals,
    subscriptions_cancelled: cancellations,
    accounts_deleted: deletions,
    active_trials: activeTrials,
    active_paid: activePaid,
    active_phase_unknown: activeUnknownPhase,
    net_subscriber_change: approvals - cancellations,
    cancellations_unresolved: unresolvedCancellations,
    cancellation_attempts_failed: failedCancellationAttempts,
  };
};

const dayLabel = (date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);

export const reportSubject = ({ start, end }) =>
  `AICONTACT weekly billing summary: ${dayLabel(start)} to ${dayLabel(end)}`;

export const reportBody = ({ start, end }, counts) => {
  const line = (label, value) => `${label.padEnd(34, ".")} ${value}`;

  const lines = [
    `AICONTACT weekly billing summary`,
    `Week of ${dayLabel(start)} to ${dayLabel(end)} (${REPORT_TIMEZONE})`,
    "",
    "During the week",
    line("New registrations", counts.registrations),
    line("PayPal subscriptions approved", counts.subscriptions_approved),
    line("Subscriptions cancelled", counts.subscriptions_cancelled),
    line("Accounts deleted", counts.accounts_deleted),
    line("Net subscriber change", counts.net_subscriber_change),
    "",
    "Right now",
    line("Active trials", counts.active_trials),
    line("Active paid subscriptions", counts.active_paid),
  ];

  if (counts.active_phase_unknown > 0) {
    lines.push(
      line("Active, trial or paid not recorded", counts.active_phase_unknown)
    );
  }

  lines.push(
    "",
    "Needs attention",
    line("Cancellations PayPal has not confirmed", counts.cancellations_unresolved),
    line("Failed cancellation attempts this week", counts.cancellation_attempts_failed),
    "",
    "Counts only. This summary contains no customer addresses or identifiers.",
    "This is a scheduled business summary, not a service alarm."
  );

  return lines.join("\n");
};

// How long a sender may hold a report before another may take it over. Only
// matters if a process dies mid-send.
const LEASE_MS = 10 * 60 * 1000;

/**
 * Sends the summary for the most recently completed week, exactly once.
 *
 * Delivery is keyed on the window, so a retry - or a second process, or a
 * restart - finds the row already sent and does nothing. A failure leaves the
 * row behind marked failed, which is what the next run picks up: an
 * undelivered week is retried rather than skipped.
 */
export const deliverWeeklyReport = async ({ now = new Date() } = {}) => {
  if (!config.ownerReport.enabled) return { skipped: "disabled" };

  // Where it would go depends on the transport: a topic for SNS, an address
  // for mail. Either way, nowhere configured means nothing to send to.
  if (!destination()) {
    logger.warn("weekly report is enabled but its transport has no destination", {
      transport: config.ownerReport.transport,
    });
    return { skipped: "no_recipient" };
  }

  const window = weeklyWindow(now, config.ownerReport.timeZone);

  // Upsert first, so the unique index on the window is what prevents a second
  // report for the same week - not a check-then-act that two processes could
  // both pass.
  await WeeklyReport.findOneAndUpdate(
    { period_start: window.start, period_end: window.end },
    { $setOnInsert: { status: "pending", generated_at: new Date(), attempts: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const leaseToken = randomToken(16);
  const staleBefore = new Date(now.getTime() - LEASE_MS);

  const claimed = await WeeklyReport.findOneAndUpdate(
    {
      period_start: window.start,
      period_end: window.end,
      status: { $ne: "sent" },
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { sending_started_at: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: "sending", lease_token: leaseToken, sending_started_at: now },
      $inc: { attempts: 1 },
    },
    { new: true }
  );

  if (!claimed) {
    // Already delivered, or another process is delivering it now.
    return { skipped: "already_delivered_or_in_flight", window };
  }

  const counts = await collectCounts(window);

  try {
    const delivery = await notifyOwner({
      subject: reportSubject(window),
      text: reportBody(window, counts),
    });

    // The default transport is "log": it writes a line and returns
    // delivered: false. Marking the week sent on that basis would lose it
    // permanently and quietly - the window never comes round again, so nobody
    // would ever find out the report had not arrived. A transport that did not
    // deliver is a failed delivery, and is retried like any other.
    if (delivery && delivery.delivered === false) {
      throw new Error(
        `owner transport "${delivery.adapter || config.ownerReport.transport}" ` +
          "did not deliver; set OWNER_REPORT_TRANSPORT"
      );
    }

    await WeeklyReport.updateOne(
      { _id: claimed._id, lease_token: leaseToken },
      {
        $set: { status: "sent", sent_at: new Date(), counts },
        $unset: { lease_token: 1, sending_started_at: 1, last_error: 1 },
      }
    );

    logger.info("weekly report sent", {
      transport: config.ownerReport.transport,
      period_start: window.start.toISOString(),
      period_end: window.end.toISOString(),
    });

    return { sent: true, window, counts };
  } catch (error) {
    // Kept, not discarded. The next run finds it failed and tries again with
    // the same window, so a bad week is never quietly lost.
    await WeeklyReport.updateOne(
      { _id: claimed._id, lease_token: leaseToken },
      {
        $set: { status: "failed", counts, last_error: String(error.message).slice(0, 500) },
        $unset: { lease_token: 1, sending_started_at: 1 },
      }
    );

    logger.error("weekly report delivery failed", { error: error.message });
    return { sent: false, failed: true, window, error: error.message };
  }
};
