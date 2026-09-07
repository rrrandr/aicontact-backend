import { config, paypalEnvironmentLabel } from "../../config/env";
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
  subscriptionPhase as applePhase,
  getSubscription,
  subscriptionPhase,
} from "../services/paypalService";
import { upsertEntitlement } from "../services/entitlementService";
import { sendEnrollmentConfirmation } from "../services/customerMail";
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
      // A Version 1 notification is a different shape entirely: notification_type
      // and unified_receipt, no signedPayload. It is worth naming, because the
      // symptom of the wrong version being configured in App Store Connect is
      // silent - subscriptions simply stop updating - and "Missing signedPayload"
      // does not tell anyone why.
      const looksV1 =
        typeof req.body?.notification_type === "string" ||
        req.body?.unified_receipt !== undefined ||
        req.body?.auto_renew_product_id !== undefined;

      if (looksV1) {
        logger.error("apple sent a VERSION 1 notification; this server only accepts VERSION 2", {
          notification_type: req.body.notification_type,
          fix: "App Store Connect > App Information > App Store Server Notifications: set both URLs to Version 2",
        });
        return res.status(400).json({
          status: "Error",
          code: "apple_notification_version_1",
          message: "This endpoint accepts App Store Server Notifications V2 only.",
        });
      }

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
            phase: applePhase(transaction),
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
          phase: applePhase(transaction),
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

// Statuses that mean PayPal will not charge again. SUSPENDED is absent for the
// same reason it is absent from the cancellation check: it can be reactivated.
const ENDS_BILLING = new Set(["CANCELLED", "EXPIRED"]);

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
      const phase = subscriptionPhase(subscription);
      const now = new Date();

      // The date the subscriber has already paid through.
      //
      // A cancellation notification arrives after PayPal has cleared
      // next_billing_time, so by the time we read it there is nothing left to
      // compute from. When we cancelled it ourselves the date is already
      // recorded; when the subscriber cancelled in PayPal's own interface we
      // are learning of it now, and the expiry we last held IS the end of the
      // period they paid for. Either way it must not be recalculated to null.
      const existing = await Entitlement.findOne({ user_id: user._id, platform: "paypal" });
      const endsNow = ENDS_BILLING.has(shape.rawStatus);
      const preserveAccessUntil = endsNow
        ? record.access_ends_at || existing?.access_ends_at || existing?.expires_at || null
        : null;

      const update = {
        status: shape.rawStatus,
        next_billing_time: shape.expiresAt,
        phase,
        updated_at: now,
      };

      // Written once, the first time PayPal reports the subscription live.
      // This is the durable record of an approval; the row itself was created
      // when the subscribe request was made, which is a different moment.
      const firstActivation = shape.rawStatus === "ACTIVE" && !record.activated_at;
      if (firstActivation) {
        update.activated_at = now;
      }

      // Only when we did not already record it. A cancellation we performed
      // ourselves holds the authoritative access-end date, and this path must
      // not replace it with whatever is left in PayPal's record afterwards.
      if (endsNow && !record.cancelled_at) {
        update.cancelled_at = now;
        update.cancellation_source = "provider";
        if (preserveAccessUntil) update.access_ends_at = preserveAccessUntil;
      }

      await PaypalSubscription.updateOne({ subscription_id: subscriptionId }, { $set: update });

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
        preserveAccessUntil,
      });

      // The retainable confirmation of what was agreed, once the subscription
      // is actually live.
      //
      // Deliberately after the entitlement write and deliberately swallowed: a
      // mail provider having a bad day must never cost somebody the access
      // they have just paid for. An unsent confirmation stays pending in the
      // ledger and the retry job picks it up.
      if (firstActivation && config.customerMail.enrollmentConfirmationEnabled) {
        try {
          await sendEnrollmentConfirmation({
            user,
            subscriptionId,
            planId: record.plan_id || shape.planId,
            record: { ...record.toObject(), ...update },
          });
        } catch (error) {
          logger.error("enrollment confirmation failed", { error: error.message });
        }
      }

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
