import { AppleTransaction } from "../../models/appleTransaction";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { requireString } from "../middleware/validate";
import {
  verifySignedPayload,
  getSubscriptionState,
  toEntitlementShape as appleShape,
  assertBundleId,
  assertEnvironmentAllowed,
  assertProductAllowed,
  AppleVerificationError,
} from "../services/appleService";
import {
  getSubscription,
  createSubscription,
  toEntitlementShape as paypalShape,
  assertKnownPlan,
  ownershipMatches,
  hasNoBinding,
  subscriberEmail,
  PaypalError,
} from "../services/paypalService";
import {
  claimAppleTransaction,
  claimPaypalSubscription,
} from "../services/claimService";
import { PaypalLegacyClaim } from "../../models/paypalLegacyClaim";
import { AuditLog } from "../../models/auditLog";
import { sendMail } from "../services/mailService";
import { config } from "../../config/env";
import crypto from "crypto";
import { sha256 } from "../../util/crypto";
import { claimWithLease, settleLease, releaseLease } from "../services/leaseService";
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

    const state = await getSubscriptionState(originalTransactionId);
    if (!state) {
      return res.status(404).json({
        status: "Error",
        code: "subscription_not_found",
        message: "Apple has no record of this subscription.",
      });
    }

    let shape;
    try {
      shape = appleShape(state, originalTransactionId);
      // Both checks fail closed and happen before anything is written.
      assertEnvironmentAllowed(shape.environment);
      assertProductAllowed(shape.productId);
    } catch (error) {
      if (error instanceof AppleVerificationError) {
        logger.warn("apple entitlement rejected", {
          code: error.code,
          user_id: String(req.user._id),
        });
        return res.status(400).json({
          status: "Error",
          code: error.code,
          message:
            error.code === "apple_environment_rejected"
              ? "This purchase was made in a test environment and cannot be used here."
              : error.code === "apple_unknown_product"
              ? "That purchase is not for an AICONTACT subscription."
              : "This purchase could not be verified with Apple.",
        });
      }
      throw error;
    }

    // One purchase, one account - claimed atomically, so two requests racing
    // for the same transaction cannot both win.
    const claim = await claimAppleTransaction(originalTransactionId, req.user._id, {
      transaction_id: shape.transactionId,
      product_id: shape.productId,
      purchase_date: shape.startsAt,
      expires_date: shape.expiresAt,
      revocation_date: shape.revocationDate,
      revocation_reason: shape.revocationReason,
      environment: shape.environment,
      updated_at: new Date(),
    });

    if (!claim.ok) {
      return res.status(409).json({
        status: "Error",
        code: "transaction_already_linked",
        message: "This purchase is already linked to a different account.",
      });
    }

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
 * Links a PayPal subscription that is already bound to this account.
 *
 * Binding is proved by custom_id, which the server sets when it creates the
 * subscription and PayPal echoes back on lookup. A subscription id on its own
 * is not evidence of anything: it appears in receipts, customer emails and
 * PayPal's own interface.
 */
export const linkPaypal = async (req, res, next) => {
  try {
    const subscriptionId = requireString(
      req.body?.subscription_id,
      "subscription_id",
      { max: 64 }
    );

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

    if (!ownershipMatches(subscription, req.user.subject_id)) {
      logger.warn("paypal link refused - ownership not proved", {
        subscription_id: subscriptionId,
        user_id: String(req.user._id),
        had_binding: !hasNoBinding(subscription),
      });
      return res.status(403).json({
        status: "Error",
        code: "paypal_ownership_unverified",
        message: hasNoBinding(subscription)
          ? "This subscription was not created through the app, so we cannot confirm it belongs to you."
          : "This subscription belongs to a different account.",
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

    const claim = await claimPaypalSubscription(subscriptionId, req.user._id, {
      plan_id: shape.planId,
      status: shape.rawStatus,
      next_billing_time: shape.expiresAt,
      updated_at: new Date(),
    });

    if (!claim.ok) {
      return res.status(409).json({
        status: "Error",
        code: "subscription_already_linked",
        message: "This subscription is already linked to a different account.",
      });
    }

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

/**
 * Creates a PayPal subscription bound to the authenticated account.
 *
 * This is the only path that establishes ownership. custom_id is taken from
 * the session, never from the request, so the caller cannot bind a
 * subscription to anyone but themselves.
 */
export const createPaypalSubscription = async (req, res, next) => {
  try {
    const planId = requireString(req.body?.plan_id, "plan_id", { max: 64 });

    try {
      assertKnownPlan(planId);
    } catch (error) {
      return res.status(400).json({
        status: "Error",
        code: error.code,
        message: "That is not an AICONTACT plan.",
      });
    }

    const created = await createSubscription({
      planId,
      customId: req.user.subject_id,
    });

    await PaypalSubscription.findOneAndUpdate(
      { subscription_id: created.id },
      {
        $set: {
          user_id: req.user._id,
          plan_id: planId,
          status: created.status,
          updated_at: new Date(),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({
      status: "Success",
      subscription_id: created.id,
      approve_url: created.approveUrl,
    });
  } catch (error) {
    if (error instanceof PaypalError) {
      return res.status(error.statusCode).json({
        status: "Error",
        code: error.code,
        message: "We could not start a subscription with PayPal. Please try again.",
      });
    }
    return next(error);
  }
};

const CLAIM_TTL_MS = 15 * 60 * 1000;
const CLAIM_MAX_ATTEMPTS = 5;

const maskEmail = (email) => {
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  const head = local.slice(0, 1);
  const tail = local.length > 1 ? local.slice(-1) : "";
  return `${head}***${tail}@${domain}`;
};

/**
 * Starts a claim for a subscription created before account binding existed.
 *
 * Ownership is proved by a code sent to the address PayPal holds for the
 * subscriber. The caller never supplies that address, so knowing the
 * subscription id is not enough. Disabled unless explicitly turned on for a
 * supervised migration window.
 */
export const startLegacyPaypalClaim = async (req, res, next) => {
  try {
    if (!config.paypal.legacyClaimEnabled) {
      return res.status(403).json({
        status: "Error",
        code: "legacy_claim_disabled",
        message: "Existing subscriptions cannot be transferred at the moment.",
      });
    }

    const subscriptionId = requireString(req.body?.subscription_id, "subscription_id", {
      max: 64,
    });

    const owned = await PaypalSubscription.findOne({ subscription_id: subscriptionId });
    if (owned && owned.user_id) {
      return res.status(409).json({
        status: "Error",
        code: "subscription_already_linked",
        message: "This subscription is already linked to an account.",
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
          message: "We could not check this subscription with PayPal.",
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

    // A subscription that already carries a binding is not legacy, and this
    // path must never be a way around that binding.
    if (!hasNoBinding(subscription)) {
      return res.status(403).json({
        status: "Error",
        code: "paypal_ownership_unverified",
        message: "This subscription is already bound to an account.",
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

    const email = subscriberEmail(subscription);
    if (!email) {
      return res.status(422).json({
        status: "Error",
        code: "paypal_no_subscriber_email",
        message: "PayPal did not give us an address to confirm ownership with.",
      });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");

    await PaypalLegacyClaim.findOneAndUpdate(
      { subscription_id: subscriptionId, user_id: req.user._id },
      {
        $set: {
          code_hash: sha256(code),
          attempts: 0,
          created_at: new Date(),
          expires_at: new Date(Date.now() + CLAIM_TTL_MS),
        },
        $unset: { consumed_at: 1 },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    await sendMail({
      to: email,
      subject: "Confirm your AICONTACT subscription",
      text: `Your confirmation code is ${code}. It expires in 15 minutes.\n\nIf you did not ask to link this subscription, ignore this message.`,
    });

    await AuditLog.create({
      action: "paypal.legacy_claim_started",
      user_id: req.user._id,
      subject_id: req.user.subject_id,
      detail: { subscription_id: subscriptionId },
    });

    return res.status(202).json({
      status: "Success",
      message: "We sent a confirmation code to the PayPal account's email address.",
      sent_to: maskEmail(email),
    });
  } catch (error) {
    return next(error);
  }
};

export const confirmLegacyPaypalClaim = async (req, res, next) => {
  try {
    if (!config.paypal.legacyClaimEnabled) {
      return res.status(403).json({
        status: "Error",
        code: "legacy_claim_disabled",
        message: "Existing subscriptions cannot be transferred at the moment.",
      });
    }

    const subscriptionId = requireString(req.body?.subscription_id, "subscription_id", {
      max: 64,
    });
    const code = requireString(req.body?.code, "code", { max: 12 });

    const invalid = () =>
      res.status(400).json({
        status: "Error",
        code: "invalid_claim_code",
        message: "That code is not valid.",
      });

    // Claimed under a lease: still single-winner against a replay or a
    // parallel guess, but a failure during the PayPal round-trip gives the
    // code back rather than spending it.
    const claim = await claimWithLease(PaypalLegacyClaim, {
      subscription_id: subscriptionId,
      user_id: req.user._id,
      code_hash: sha256(code),
      consumed_at: { $exists: false },
      expires_at: { $gt: new Date() },
      attempts: { $lt: CLAIM_MAX_ATTEMPTS },
    });

    if (!claim) {
      await PaypalLegacyClaim.updateOne(
        { subscription_id: subscriptionId, user_id: req.user._id },
        { $inc: { attempts: 1 } }
      );
      return invalid();
    }

    try {
      const subscription = await getSubscription(subscriptionId);

      if (!subscription || !hasNoBinding(subscription)) {
        await releaseLease(PaypalLegacyClaim, claim._id);
        return invalid();
      }

      const shape = paypalShape(subscription);
      if (shape.status !== "active" && shape.status !== "grace") {
        await releaseLease(PaypalLegacyClaim, claim._id);
        return res.status(400).json({
          status: "Error",
          code: "subscription_not_active",
          message: `This subscription is ${shape.rawStatus.toLowerCase()}.`,
        });
      }

      const claimed = await claimPaypalSubscription(subscriptionId, req.user._id, {
        plan_id: shape.planId,
        status: shape.rawStatus,
        next_billing_time: shape.expiresAt,
        legacy_claim: true,
        updated_at: new Date(),
      });

      if (!claimed.ok) {
        await releaseLease(PaypalLegacyClaim, claim._id);
        return res.status(409).json({
          status: "Error",
          code: "subscription_already_linked",
          message: "This subscription is already linked to a different account.",
        });
      }

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

      // The subscription is bound and the entitlement written, so the code is
      // now genuinely spent.
      await settleLease(PaypalLegacyClaim, claim._id, "consumed_at");

      await AuditLog.create({
        action: "paypal.legacy_claim_confirmed",
        user_id: req.user._id,
        subject_id: req.user.subject_id,
        detail: { subscription_id: subscriptionId },
      });

      return res.status(200).json({
        status: "Success",
        entitlement: await resolveEntitlement(req.user),
      });
    } catch (error) {
      await releaseLease(PaypalLegacyClaim, claim._id, error);
      throw error;
    }
  } catch (error) {
    return next(error);
  }
};
