import { WebhookEvent } from "../../models/webhookEvent";
import { AppleTransaction } from "../../models/appleTransaction";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { Entitlement } from "../../models/entitlement";
import { User } from "../../models/user";
import {
  verifySignedPayload,
  assertBundleId,
  AppleVerificationError,
} from "../services/appleService";
import { verifyWebhookSignature, toEntitlementShape } from "../services/paypalService";
import { upsertEntitlement } from "../services/entitlementService";
import { logger } from "../../util/logger";

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

const firstSeen = async (provider, eventId, eventType) => {
  try {
    await WebhookEvent.create({
      provider,
      event_id: eventId,
      event_type: eventType,
    });
    return true;
  } catch (error) {
    // Duplicate key: we have seen this event before.
    if (error.code === 11000) return false;
    throw error;
  }
};

const complete = (provider, eventId, outcome) =>
  WebhookEvent.updateOne(
    { provider, event_id: eventId },
    { $set: { processed_at: new Date(), outcome } }
  );

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

    if (!(await firstSeen("apple", eventId, notification.notificationType))) {
      logger.info("apple webhook duplicate ignored", { event_id: eventId });
      return res.status(200).json({ status: "Success", duplicate: true });
    }

    const data = notification.data || {};
    const transaction = data.signedTransactionInfo
      ? verifySignedPayload(data.signedTransactionInfo)
      : {};
    const renewal = data.signedRenewalInfo
      ? verifySignedPayload(data.signedRenewalInfo)
      : {};

    const originalTransactionId = transaction.originalTransactionId;
    if (!originalTransactionId) {
      await complete("apple", eventId, "no-transaction");
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
      await complete("apple", eventId, "unlinked-transaction");
      return res.status(200).json({ status: "Success", unlinked: true });
    }

    const mapped = APPLE_STATUS[notification.notificationType];
    const user = await User.findById(record.user_id);

    if (!user) {
      await complete("apple", eventId, "user-missing");
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

    await complete("apple", eventId, notification.notificationType);
    return res.status(200).json({ status: "Success" });
  } catch (error) {
    // A retry might succeed here, so let the provider retry.
    return next(error);
  }
};

const PAYPAL_STATUS = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "active",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED": "active",
  "BILLING.SUBSCRIPTION.UPDATED": "active",
  "BILLING.SUBSCRIPTION.SUSPENDED": "grace",
  "BILLING.SUBSCRIPTION.CANCELLED": "expired",
  "BILLING.SUBSCRIPTION.EXPIRED": "expired",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "grace",
};

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

    if (!(await firstSeen("paypal", eventId, event.event_type))) {
      logger.info("paypal webhook duplicate ignored", { event_id: eventId });
      return res.status(200).json({ status: "Success", duplicate: true });
    }

    const subscriptionId = event.resource?.id;
    const mapped = PAYPAL_STATUS[event.event_type];

    if (!subscriptionId || !mapped) {
      await complete("paypal", eventId, "ignored");
      return res.status(200).json({ status: "Success", ignored: true });
    }

    const record = await PaypalSubscription.findOne({ subscription_id: subscriptionId });

    if (!record || !record.user_id) {
      await complete("paypal", eventId, "unlinked-subscription");
      return res.status(200).json({ status: "Success", unlinked: true });
    }

    const user = await User.findById(record.user_id);
    if (!user) {
      await complete("paypal", eventId, "user-missing");
      return res.status(200).json({ status: "Success", ignored: true });
    }

    const shape = toEntitlementShape(event.resource);

    await PaypalSubscription.updateOne(
      { subscription_id: subscriptionId },
      {
        $set: {
          status: event.resource?.status || shape.rawStatus,
          next_billing_time: shape.expiresAt,
          updated_at: new Date(),
        },
      }
    );

    await upsertEntitlement({
      user,
      platform: "paypal",
      productId: record.plan_id || shape.planId,
      status: mapped,
      startsAt: shape.startsAt,
      expiresAt: shape.expiresAt,
      autoRenew: mapped === "active",
      sourceRef: subscriptionId,
    });

    await complete("paypal", eventId, event.event_type);
    return res.status(200).json({ status: "Success" });
  } catch (error) {
    return next(error);
  }
};
