import { AuditLog } from "../../models/auditLog";
import { Entitlement } from "../../models/entitlement";
import { AppleTransaction } from "../../models/appleTransaction";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { PendingCancellation } from "../../models/pendingCancellation";
import { WebhookEvent } from "../../models/webhookEvent";
import { cancelSubscription } from "./paypalService";
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

  const detached = { user_id: { $exists: false } };

  const [auditLogs, entitlements, appleTransactions, paypalSubscriptions, webhookEvents] =
    await Promise.all([
      AuditLog.deleteMany({ at: { $lt: auditCutoff } }),
      Entitlement.deleteMany({ ...detached, updated_at: { $lt: financialCutoff } }),
      AppleTransaction.deleteMany({ ...detached, updated_at: { $lt: financialCutoff } }),
      PaypalSubscription.deleteMany({ ...detached, updated_at: { $lt: financialCutoff } }),
      WebhookEvent.deleteMany({ received_at: { $lt: auditCutoff } }),
    ]);

  const result = {
    audit_logs: auditLogs.deletedCount ?? 0,
    entitlements: entitlements.deletedCount ?? 0,
    apple_transactions: appleTransactions.deletedCount ?? 0,
    paypal_subscriptions: paypalSubscriptions.deletedCount ?? 0,
    webhook_events: webhookEvents.deletedCount ?? 0,
  };

  logger.info("retention purge complete", result);
  return result;
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
  ];

  // Maintenance must never hold the process open on its own.
  timers.forEach((timer) => timer.unref());

  return () => timers.forEach(clearInterval);
};
