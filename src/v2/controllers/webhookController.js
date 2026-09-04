import { paypalEnvironmentLabel } from "../../config/env";
import { WebhookEvent } from "../../models/webhookEvent";
import { AppleTransaction } from "../../models/appleTransaction";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { Entitlement } from "../../models/entitlement";
import { User } from "../../models/user";
import {
  verifySignedPayload,
  assertBundleId,
  environmentAllowed,
  AppleVerificationError,
} from "../services/appleService";
import {
  verifyWebhookSignature,
  toEntitlementShape,
  getSubscription,
} from "../services/paypalService";
import { upsertEntitlement } from "../services/entitlementService";
import { logger } from "../../util/logger";
import { randomToken } from "../../util/crypto";

/**
 * Webhook handling.
 *
 * Both providers retry anything that is not a 2xx, so a duplicate has to be
 * recognised and acknowledged rather than reprocessed, and an event we cannot
 * act on still gets a 200 - otherwise the provider retries forever over
 * something a retry will never fix.
 *
 * A 500 is reserved for failures a retry genuinely might resolve.
 */

// How long a processor may hold an event before another may take it over.
// Only matters if a process dies mid-handler; ordinary failures release the
// lease immediately.
const LEASE_MS = 60 * 1000;

/**
 * Takes exclusive ownership of an event for processing.
 *
 * Recording the event and then processing it loses any delivery that fails
 * afterwards: the provider retries, the insert reports a duplicate, and the
 * event is acknowledged without ever having been handled. Instead the claim
 * matches only events that are not yet finished, so a failed delivery can be
 * retried while a concurrent one still cannot start.
 */
const claimEvent = async (provider, eventId, eventType) => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_MS);
  const leaseToken = randomToken(16);

  try {
    await WebhookEvent.findOneAndUpdate(
      {
        provider,
        event_id: eventId,
        processed_at: { $exists: false },
        $or: [
          { processing_started_at: { $exists: false } },
          { processing_started_at: null },
          { processing_started_at: { $lte: staleBefore } },
        ],
      },
      {
        $set: { event_type: eventType, processing_started_at: now, lease_token: leaseToken },
        $inc: { attempts: 1 },
        $setOnInsert: { received_at: now },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return leaseToken;
  } catch (error) {
    // Duplicate key: the event is either finished or being processed now.
    if (error.code === 11000) return null;
    throw error;
  }
};

// Both of these are fenced on lease_token: a worker whose lease went stale
// must not be able to mark its successor's work finished, or clear the lease
// its successor is currently holding.
const complete = async (provider, eventId, outcome, leaseToken) => {
  const result = await WebhookEvent.updateOne(
    { provider, event_id: eventId, lease_token: leaseToken },
    {
      $set: { processed_at: new Date(), outcome },
      $unset: { processing_started_at: 1, lease_token: 1 },
    }
  );
  if ((result.modifiedCount ?? 0) === 0) {
    logger.warn("stale webhook worker could not settle", { provider, event_id: eventId });
  }
};

const release = async (provider, eventId, leaseToken, error) => {
  const result = await WebhookEvent.updateOne(
    { provider, event_id: eventId, lease_token: leaseToken },
    {
      $set: { last_error: String(error && error.message).slice(0, 500) },
      $unset: { processing_started_at: 1, lease_token: 1 },
    }
  );
  if ((result.modifiedCount ?? 0) === 0) {
    logger.warn("stale webhook worker could not release", { provider, event_id: eventId });
  }
};

// Apple notification types mapped onto entitlement status.
const APPLE_STATUS = {
  SUBSCRIBED: "active",
  DID_RENEW: "active",
  OFFER_REDEEMED: "active",
  DID_CHANGE_RENEWAL_STATUS: null, // status unchanged; only auto-renew moves
  DID_FAIL_TO_RENEW: "grace",
  GRACE_PERIOD_EXPIRED: "expired",
  EXPIRED: "expired",
  REFUND: "refunded",
  REVOKE: "revoked",
};

export const appleWebhook = async (req, res, next) => {
  try {
    const signedPayload = req.body?.signedPayload;

    if (typeof signedPayload !== "string") {
      return res.status(400).json({ status: "Error", message: "Missing signedPayload" });
    }

    let notification;
    try {
      notification = verifySignedPayload(signedPayload);
      assertBundleId(notification.data || notification);
    } catch (error) {
      if (error instanceof AppleVerificationError) {
        logger.warn("apple webhook rejected", { code: error.code });
        // Unverifiable: refuse it, and do not invite a retry.
        return res.status(400).json({ status: "Error", message: "Verification failed" });
      }
      throw error;
    }

    const eventId = notification.notificationUUID;
    if (!eventId) {
      return res.status(400).json({ status: "Error", message: "Missing notificationUUID" });
    }

    const lease = await claimEvent("apple", eventId, notification.notificationType);
    if (!lease) {
      logger.info("apple webhook duplicate ignored", { event_id: eventId });
      return res.status(200).json({ status: "Success", duplicate: true });
    }

    try {

    const data = notification.data || {};
    const transaction = data.signedTransactionInfo
      ? verifySignedPayload(data.signedTransactionInfo)
      : {};
    const renewal = data.signedRenewalInfo
      ? verifySignedPayload(data.signedRenewalInfo)
      : {};

    const originalTransactionId = transaction.originalTransactionId;
    if (!originalTransactionId) {
      await complete("apple", eventId, "no-transaction", lease);
      return res.status(200).json({ status: "Success", ignored: true });
    }

    const record = await AppleTransaction.findOne({
      original_transaction_id: originalTransactionId,
    });

    // A notification can arrive before the client has verified its purchase.
    // Record it so the state is not lost, then stop.
    if (!record || !record.user_id) {
      await AppleTransaction.findOneAndUpdate(
        { original_transaction_id: originalTransactionId },
        {
          $set: {
            transaction_id: transaction.transactionId,
            product_id: transaction.productId,
            expires_date: transaction.expiresDate ? new Date(transaction.expiresDate) : null,
            environment: data.environment,
            last_notification_uuid: eventId,
            updated_at: new Date(),
          },
        },
        { upsert: true, setDefaultsOnInsert: true }
      );
      await complete("apple", eventId, "unlinked-transaction", lease);
      return res.status(200).json({ status: "Success", unlinked: true });
    }

    const mapped = APPLE_STATUS[notification.notificationType];
    const user = await User.findById(record.user_id);

    if (!user) {
      await complete("apple", eventId, "user-missing", lease);
      return res.status(200).json({ status: "Success", ignored: true });
    }

    // The same environment policy as the verify endpoint. A sandbox
    // notification must not be able to activate a production entitlement.
    if (mapped && !environmentAllowed(data.environment)) {
      logger.warn("apple webhook ignored for disallowed environment", {
        environment: data.environment,
        event_id: eventId,
      });
      await complete("apple", eventId, "environment-rejected", lease);
      return res.status(200).json({ status: "Success", ignored: true });
    }

    if (mapped) {
      await upsertEntitlement({
        user,
        platform: "apple",
        productId: transaction.productId,
        status: transaction.revocationDate ? "refunded" : mapped,
        startsAt: transaction.purchaseDate ? new Date(transaction.purchaseDate) : null,
        expiresAt: transaction.expiresDate ? new Date(transaction.expiresDate) : null,
        autoRenew: renewal.autoRenewStatus === 1,
        environment: data.environment,
        sourceRef: originalTransactionId,
      });
    } else if (notification.notificationType === "DID_CHANGE_RENEWAL_STATUS") {
      await Entitlement.updateOne(
        { user_id: user._id, platform: "apple" },
        { $set: { auto_renew: renewal.autoRenewStatus === 1, updated_at: new Date() } }
      );
    }

    await AppleTransaction.updateOne(
      { original_transaction_id: originalTransactionId },
      {
        $set: {
          expires_date: transaction.expiresDate ? new Date(transaction.expiresDate) : null,
          revocation_date: transaction.revocationDate
            ? new Date(transaction.revocationDate)
            : null,
          last_notification_uuid: eventId,
          updated_at: new Date(),
        },
      }
    );

      await complete("apple", eventId, notification.notificationType, lease);
      return res.status(200).json({ status: "Success" });
    } catch (error) {
      // Release the claim so Apple's retry is processed rather than being
      // dismissed as a duplicate, then let the error produce a 5xx.
      await release("apple", eventId, lease, error);
      throw error;
    }
  } catch (error) {
    return next(error);
  }
};

/**
 * Event types that affect entitlement.
 *
 * The value is only used to decide whether we care; the resulting status
 * always comes from PayPal's own record, never from the event body.
 */
const PAYPAL_HANDLED = new Set([
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  // Renewals. Without these, next_billing_time goes stale and a paying
  // subscriber loses access on their next billing date.
  "PAYMENT.SALE.COMPLETED",
  "PAYMENT.SALE.DENIED",
  "PAYMENT.SALE.REFUNDED",
  "PAYMENT.SALE.REVERSED",
]);

// Subscription events carry the id directly; payment events reference it as
// the billing agreement.
const paypalSubscriptionId = (event) =>
  event.resource?.id && String(event.event_type || "").startsWith("BILLING.SUBSCRIPTION")
    ? event.resource.id
    : event.resource?.billing_agreement_id || null;

export const paypalWebhook = async (req, res, next) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body ?? {});

    if (!(await verifyWebhookSignature(req.headers, rawBody))) {
      logger.warn("paypal webhook signature rejected");
      return res.status(400).json({ status: "Error", message: "Verification failed" });
    }

    const event = req.body ?? {};
    const eventId = event.id;

    if (!eventId) {
      return res.status(400).json({ status: "Error", message: "Missing event id" });
    }

    const lease = await claimEvent("paypal", eventId, event.event_type);
    if (!lease) {
      logger.info("paypal webhook duplicate ignored", { event_id: eventId });
      return res.status(200).json({ status: "Success", duplicate: true });
    }

    try {
      const subscriptionId = paypalSubscriptionId(event);

      if (!subscriptionId || !PAYPAL_HANDLED.has(event.event_type)) {
        await complete("paypal", eventId, "ignored", lease);
        return res.status(200).json({ status: "Success", ignored: true });
      }

      const record = await PaypalSubscription.findOne({ subscription_id: subscriptionId });

      if (!record || !record.user_id) {
        await complete("paypal", eventId, "unlinked-subscription", lease);
        return res.status(200).json({ status: "Success", unlinked: true });
      }

      const user = await User.findById(record.user_id);
      if (!user) {
        await complete("paypal", eventId, "user-missing", lease);
        return res.status(200).json({ status: "Success", ignored: true });
      }

      // Authoritative refresh. The event body is a notification, not a source
      // of truth - it can be stale, reordered, or describe a payment whose
      // subscription has since been cancelled.
      const subscription = await getSubscription(subscriptionId);

      if (!subscription) {
        await complete("paypal", eventId, "subscription-missing", lease);
        return res.status(200).json({ status: "Success", ignored: true });
      }

      const shape = toEntitlementShape(subscription);

      await PaypalSubscription.updateOne(
        { subscription_id: subscriptionId },
        {
          $set: {
            status: shape.rawStatus,
            next_billing_time: shape.expiresAt,
            updated_at: new Date(),
          },
        }
      );

      await upsertEntitlement({
        user,
        platform: "paypal",
        environment: paypalEnvironmentLabel(),
        productId: record.plan_id || shape.planId,
        status: shape.status,
        startsAt: shape.startsAt,
        expiresAt: shape.expiresAt,
        autoRenew: shape.autoRenew,
        sourceRef: subscriptionId,
      });

      await complete("paypal", eventId, event.event_type, lease);
      return res.status(200).json({ status: "Success" });
    } catch (error) {
      await release("paypal", eventId, lease, error);
      throw error;
    }
  } catch (error) {
    return next(error);
  }
};
