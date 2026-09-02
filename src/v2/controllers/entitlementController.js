import { AppleTransaction } from "../../models/appleTransaction";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { requireString } from "../middleware/validate";
import {
  verifySignedPayload,
  getSubscriptionState,
  toEntitlementShape as appleShape,
  assertBundleId,
  AppleVerificationError,
} from "../services/appleService";
import {
  getSubscription,
  toEntitlementShape as paypalShape,
  assertKnownPlan,
  PaypalError,
} from "../services/paypalService";
import { upsertEntitlement, resolveEntitlement } from "../services/entitlementService";
import { logger } from "../../util/logger";

export const getEntitlement = async (req, res, next) => {
  try {
    return res.status(200).json({
      status: "Success",
      entitlement: await resolveEntitlement(req.user),
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Apple purchase verification.
 *
 * The client submits the StoreKit 2 signed transaction. Its signature is
 * checked against a pinned Apple root, and then - crucially - the current
 * state is read from the App Store Server API. A valid signature only proves
 * the purchase happened at some point; it says nothing about whether it was
 * since refunded, revoked, or allowed to lapse.
 */
export const verifyApple = async (req, res, next) => {
  try {
    const signedTransaction = requireString(
      req.body?.signed_transaction,
      "signed_transaction",
      { max: 20000 }
    );

    let payload;
    try {
      payload = verifySignedPayload(signedTransaction);
      assertBundleId(payload);
    } catch (error) {
      if (error instanceof AppleVerificationError) {
        logger.warn("apple verification rejected", {
          code: error.code,
          user_id: String(req.user._id),
        });
        return res.status(400).json({
          status: "Error",
          code: error.code,
          message: "This purchase could not be verified with Apple.",
        });
      }
      throw error;
    }

    const originalTransactionId = payload.originalTransactionId;
    if (!originalTransactionId) {
      return res.status(400).json({
        status: "Error",
        code: "apple_verification_failed",
        message: "This purchase could not be verified with Apple.",
      });
    }

    // One purchase, one account. Without this a single subscription could be
    // presented against unlimited accounts.
    const existing = await AppleTransaction.findOne({
      original_transaction_id: originalTransactionId,
    });

    if (existing && existing.user_id && String(existing.user_id) !== String(req.user._id)) {
      logger.warn("apple transaction claimed by another account", {
        original_transaction_id: originalTransactionId,
      });
      return res.status(409).json({
        status: "Error",
        code: "transaction_already_linked",
        message: "This purchase is already linked to a different account.",
      });
    }

    const state = await getSubscriptionState(originalTransactionId);
    if (!state) {
      return res.status(404).json({
        status: "Error",
        code: "subscription_not_found",
        message: "Apple has no record of this subscription.",
      });
    }

    const shape = appleShape(state);

    await AppleTransaction.findOneAndUpdate(
      { original_transaction_id: originalTransactionId },
      {
        $set: {
          transaction_id: shape.transactionId,
          user_id: req.user._id,
          product_id: shape.productId,
          purchase_date: shape.startsAt,
          expires_date: shape.expiresAt,
          revocation_date: shape.revocationDate,
          revocation_reason: shape.revocationReason,
          environment: shape.environment,
          updated_at: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await upsertEntitlement({
      user: req.user,
      platform: "apple",
      productId: shape.productId,
      status: shape.status,
      startsAt: shape.startsAt,
      expiresAt: shape.expiresAt,
      autoRenew: shape.autoRenew,
      environment: shape.environment,
      sourceRef: originalTransactionId,
    });

    return res.status(200).json({
      status: "Success",
      entitlement: await resolveEntitlement(req.user),
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * PayPal subscription linking.
 *
 * Subscription IDs are not secrets and are freely shareable, so the binding is
 * exclusive: the first account to present one owns it, and any other account
 * presenting the same ID is refused.
 */
export const linkPaypal = async (req, res, next) => {
  try {
    const subscriptionId = requireString(
      req.body?.subscription_id,
      "subscription_id",
      { max: 64 }
    );

    const existing = await PaypalSubscription.findOne({
      subscription_id: subscriptionId,
    });

    if (existing && existing.user_id && String(existing.user_id) !== String(req.user._id)) {
      logger.warn("paypal subscription claimed by another account", {
        subscription_id: subscriptionId,
      });
      return res.status(409).json({
        status: "Error",
        code: "subscription_already_linked",
        message: "This subscription is already linked to a different account.",
      });
    }

    let subscription;
    try {
      subscription = await getSubscription(subscriptionId);
    } catch (error) {
      if (error instanceof PaypalError) {
        return res.status(error.statusCode).json({
          status: "Error",
          code: error.code,
          message: "We could not check this subscription with PayPal. Please try again.",
        });
      }
      throw error;
    }

    if (!subscription) {
      return res.status(404).json({
        status: "Error",
        code: "subscription_not_found",
        message: "PayPal has no record of that subscription.",
      });
    }

    try {
      assertKnownPlan(subscription.plan_id);
    } catch (error) {
      return res.status(400).json({
        status: "Error",
        code: error.code,
        message: "That subscription is not for an AICONTACT plan.",
      });
    }

    const shape = paypalShape(subscription);

    if (shape.status !== "active" && shape.status !== "grace") {
      return res.status(400).json({
        status: "Error",
        code: "subscription_not_active",
        message: `This subscription is ${shape.rawStatus.toLowerCase()}.`,
      });
    }

    await PaypalSubscription.findOneAndUpdate(
      { subscription_id: subscriptionId },
      {
        $set: {
          user_id: req.user._id,
          plan_id: shape.planId,
          status: shape.rawStatus,
          next_billing_time: shape.expiresAt,
          updated_at: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await upsertEntitlement({
      user: req.user,
      platform: "paypal",
      productId: shape.planId,
      status: shape.status,
      startsAt: shape.startsAt,
      expiresAt: shape.expiresAt,
      autoRenew: shape.autoRenew,
      sourceRef: subscriptionId,
    });

    return res.status(200).json({
      status: "Success",
      entitlement: await resolveEntitlement(req.user),
    });
  } catch (error) {
    return next(error);
  }
};
