import { AuditLog } from "../../models/auditLog";
import { Entitlement } from "../../models/entitlement";
import { AppleTransaction } from "../../models/appleTransaction";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { PendingCancellation } from "../../models/pendingCancellation";
import { CancellationFeedback } from "../../models/cancellationFeedback";
import { WebhookEvent } from "../../models/webhookEvent";
import { User } from "../../models/user";
import { cancelSubscription } from "./paypalService";
import { sendAnnualRenewalReminder, retryPendingMessages } from "./customerMail";
import { deliverWeeklyReport } from "./weeklyReportService";
import { config } from "../../config/env";
import { logger } from "../../util/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Applies the configured retention periods.
 *
 * A retention policy that exists only as a configuration value is not a
 * policy, so this actually deletes. Records still attached to a live account
 * are never touched - retention governs how long data outlives the account,
 * not how long an account may exist.
 */
export const purgeExpiredRecords = async () => {
  const auditCutoff = new Date(Date.now() - config.retention.auditLogDays * DAY_MS);
  const financialCutoff = new Date(
    Date.now() - config.retention.financialRecordDays * DAY_MS
  );

  const feedbackCutoff = new Date(
    Date.now() - config.retention.cancellationFeedbackDays * DAY_MS
  );

  const detached = { user_id: { $exists: false } };

  const [
    auditLogs,
    entitlements,
    appleTransactions,
    paypalSubscriptions,
    webhookEvents,
    cancellationFeedback,
  ] =
    await Promise.all([
      AuditLog.deleteMany({ at: { $lt: auditCutoff } }),
      Entitlement.deleteMany({ ...detached, updated_at: { $lt: financialCutoff } }),
      AppleTransaction.deleteMany({ ...detached, updated_at: { $lt: financialCutoff } }),
      PaypalSubscription.deleteMany({ ...detached, updated_at: { $lt: financialCutoff } }),
      WebhookEvent.deleteMany({ received_at: { $lt: auditCutoff } }),
      CancellationFeedback.deleteMany({ at: { $lt: feedbackCutoff } }),
    ]);

  const result = {
    audit_logs: auditLogs.deletedCount ?? 0,
    entitlements: entitlements.deletedCount ?? 0,
    apple_transactions: appleTransactions.deletedCount ?? 0,
    paypal_subscriptions: paypalSubscriptions.deletedCount ?? 0,
    webhook_events: webhookEvents.deletedCount ?? 0,
    cancellation_feedback: cancellationFeedback.deletedCount ?? 0,
  };

  logger.info("retention purge complete", result);
  return result;
};

const YEAR_MS = 365 * DAY_MS;

/**
 * Sends the annual reminder to subscribers whose subscription has been running
 * for a year or more since the last one.
 *
 * Sent to everyone, not only to subscribers we believe are in California.
 * Working out who is Californian would mean collecting location data we do not
 * collect and have told people we do not collect; the reminder costs nothing
 * to send to the rest, and a subscriber being reminded that they are paying us
 * is not a harm we need to avoid.
 *
 * Idempotence is the ledger's, not this job's: the anniversary year is part of
 * the message key, so running this hourly and running it once a year send the
 * same single message.
 */
export const sendDueAnnualReminders = async (limit = 100) => {
  if (!config.customerMail.annualReminderEnabled) {
    return { skipped: "disabled" };
  }

  const cutoff = new Date(Date.now() - YEAR_MS);

  const due = await PaypalSubscription.find({
    user_id: { $exists: true },
    activated_at: { $lt: cutoff, $exists: true },
    cancelled_at: { $exists: false },
  })
    .sort({ activated_at: 1 })
    .limit(limit);

  let sent = 0;

  for (const record of due) {
    const years = Math.floor((Date.now() - record.activated_at.getTime()) / YEAR_MS);
    if (years < 1) continue;

    const user = await User.findById(record.user_id);
    if (!user || user.status === "deleted") continue;

    try {
      const result = await sendAnnualRenewalReminder({
        user,
        subscriptionId: record.subscription_id,
        // The anniversary, not the calendar year: a subscription that started
        // in December gets its reminder in December.
        year: years,
        record,
      });
      if (result.sent) sent += 1;
    } catch (error) {
      logger.error("annual reminder failed", { error: error.message });
    }
  }

  return { examined: due.length, sent };
};

const MAX_CANCELLATION_ATTEMPTS = 100;

/**
 * Retries cancellations that could not be confirmed during account deletion.
 *
 * The account is usually gone by now, so nobody is left to notice a
 * subscription that is still billing. This is the recovery path that stops it.
 */
export const retryPendingCancellations = async (limit = 25) => {
  const jobs = await PendingCancellation.find({
    resolved_at: { $exists: false },
    attempts: { $lt: MAX_CANCELLATION_ATTEMPTS },
  })
    .sort({ last_attempt_at: 1 })
    .limit(limit);

  let resolved = 0;
  let failed = 0;

  for (const job of jobs) {
    let result;
    try {
      result = await cancelSubscription(job.subscription_id, job.reason || "Account deleted");
    } catch (error) {
      result = { cancelled: false, confirmed: false, detail: error.message };
    }

    if (result.cancelled) {
      job.resolved_at = new Date();
      resolved += 1;
    } else {
      failed += 1;
      logger.warn("pending cancellation still unresolved", {
        subscription_id: job.subscription_id,
        attempts: job.attempts + 1,
        detail: result.detail,
      });
    }

    job.attempts += 1;
    job.last_attempt_at = new Date();
    job.last_error = result.cancelled ? undefined : String(result.detail).slice(0, 500);
    await job.save();
  }

  return { examined: jobs.length, resolved, failed };
};

/**
 * Periodic maintenance. Started from index.js when v2 is enabled; returns a
 * stop function so tests and shutdown can clear the timers.
 */
export const startMaintenance = ({
  purgeIntervalMs = 6 * 60 * 60 * 1000,
  cancellationIntervalMs = 15 * 60 * 1000,
  weeklyReportIntervalMs = config.ownerReport.checkIntervalMs,
  customerMailIntervalMs = 60 * 60 * 1000,
} = {}) => {
  const guard = (fn, name) => async () => {
    try {
      await fn();
    } catch (error) {
      logger.error(`${name} failed`, { error: error.message });
    }
  };

  const timers = [
    setInterval(guard(purgeExpiredRecords, "retention purge"), purgeIntervalMs),
    setInterval(
      guard(retryPendingCancellations, "cancellation retry"),
      cancellationIntervalMs
    ),
    // Polls rather than schedules. The window decides what is owed, and the
    // stored report decides whether it has already been sent, so ticking often
    // costs nothing and a missed tick loses nothing.
    setInterval(
      guard(() => deliverWeeklyReport({}), "weekly report"),
      weeklyReportIntervalMs
    ),
    // Required customer notices. Both are idempotent at the ledger, so the
    // interval only decides how promptly a missed one is caught up.
    setInterval(guard(sendDueAnnualReminders, "annual reminders"), customerMailIntervalMs),
    setInterval(guard(retryPendingMessages, "customer mail retry"), customerMailIntervalMs),
  ];

  // Maintenance must never hold the process open on its own.
  timers.forEach((timer) => timer.unref());

  return () => timers.forEach(clearInterval);
};
