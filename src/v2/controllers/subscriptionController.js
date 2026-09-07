import { Entitlement } from "../../models/entitlement";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { AppleTransaction } from "../../models/appleTransaction";
import {
  CancellationFeedback,
  FEEDBACK_REASONS,
  MAX_COMMENT_LENGTH,
} from "../../models/cancellationFeedback";
import { cancelForUser, CancellationSource } from "../services/cancellationService";
import { resolveEntitlement, isActive } from "../services/entitlementService";
import { logger } from "../../util/logger";

/**
 * Subscription management for the signed-in account.
 *
 * Everything here is scoped to req.user from the first query. No handler
 * accepts a subscription id from the client, so there is no request shape that
 * could name somebody else's subscription, and no response carries one - the
 * client does not need it, and it appears in receipts and PayPal's own
 * interface, so it is not a secret worth handing around either.
 */

// Where a subscriber manages PayPal's side of the arrangement themselves. A
// fallback, not the primary route: cancelling in the app is one button.
export const PAYPAL_AUTOPAY_URL = "https://www.paypal.com/myaccount/autopay/";

/**
 * Where an App Store subscriber manages their subscription.
 *
 * Apple does not let a third party cancel on a subscriber's behalf, and the
 * guidelines require the app to send them here. So on Apple the Cancel button
 * is not a button that cancels - it is a link, and the client must not claim
 * otherwise.
 */
export const APPLE_MANAGE_URL = "https://apps.apple.com/account/subscriptions";

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * What the "Manage Subscription" screen renders.
 *
 * Derived from the entitlement, which is the authority, with the trial/paid
 * distinction taken from the provider's own bookkeeping rather than guessed
 * from dates - PayPal's cycle executions, Apple's offer fields.
 *
 * The provider decides one thing beyond that: whether we can cancel at all.
 * We can end a PayPal subscription; Apple does not permit it, so an App Store
 * subscriber is sent to their App Store settings instead.
 */
export const buildSubscriptionView = (entitlement, record) => {
  const apple = entitlement?.platform === "apple";
  const active = isActive(entitlement);
  const cancelled = Boolean(entitlement?.cancelled_at || record?.cancelled_at);
  const phase = record?.phase && record.phase !== "unknown" ? record.phase : null;

  const state = !entitlement
    ? // A subscription was created but PayPal has not confirmed it. Saying
      // "no subscription" next to a Cancel button would be a contradiction.
      record && !cancelled
      ? "pending"
      : "none"
    : cancelled && active
    ? "cancelled"
    : !active
    ? "expired"
    : phase === "trial"
    ? "trialing"
    : "active";

  return {
    state,
    platform: entitlement ? entitlement.platform : null,
    phase,
    // Present whenever access has a known end, cancelled or not.
    access_ends_at: toIso(entitlement?.access_ends_at || entitlement?.expires_at),
    // Only a subscription that will actually be charged again has a renewal
    // date. After cancellation this is null, and the client shows the
    // access-end date instead of inventing a renewal that will not happen.
    next_renewal_at:
      entitlement && entitlement.auto_renew && !cancelled
        ? toIso(entitlement.expires_at)
        : null,
    auto_renew: Boolean(entitlement?.auto_renew) && !cancelled,
    cancelled_at: toIso(entitlement?.cancelled_at || record?.cancelled_at),
    cancellation_source:
      entitlement?.cancellation_source || record?.cancellation_source || null,
    // Only a live PayPal subscription that has not already been cancelled can
    // be cancelled from here. An Apple subscription never can: the client must
    // send the subscriber to their App Store settings rather than offering a
    // button that cannot do what it says.
    can_cancel: apple ? false : Boolean(record) && !cancelled,
    manage_url: apple ? APPLE_MANAGE_URL : PAYPAL_AUTOPAY_URL,
  };
};

export const getSubscription = async (req, res, next) => {
  try {
    // Whichever provider this account actually bought through. Looking only at
    // PayPal showed an App Store subscriber an empty screen.
    const [paypalEntitlement, appleEntitlement, paypalRecord, appleRecord, feedback] =
      await Promise.all([
        Entitlement.findOne({ user_id: req.user._id, platform: "paypal" }),
        Entitlement.findOne({ user_id: req.user._id, platform: "apple" }),
        PaypalSubscription.findOne({ user_id: req.user._id }),
        AppleTransaction.findOne({ user_id: req.user._id }),
        CancellationFeedback.exists({ subject_id: req.user.subject_id }),
      ]);

    // An account should only ever have one, but if both exist the live one
    // wins - and PayPal breaks the tie, because that is the subscription this
    // app can actually manage.
    const useApple = !isActive(paypalEntitlement) && isActive(appleEntitlement);
    const entitlement = useApple ? appleEntitlement : paypalEntitlement;
    const record = useApple ? appleRecord : paypalRecord;

    return res.status(200).json({
      status: "Success",
      subscription: buildSubscriptionView(entitlement, record),
      // So the client can offer to take it back. Feedback is given on consent,
      // and consent that cannot be withdrawn is not consent.
      feedback_given: Boolean(feedback),
      entitlement: await resolveEntitlement(req.user),
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Stops future renewals. Access continues to the date already paid for.
 *
 * Failure is closed: unless PayPal's own record confirms the subscription is no
 * longer billing, this returns an error and says so, however the local database
 * looks. Claiming success on a local write would leave someone believing they
 * had cancelled while PayPal kept charging them.
 */
export const cancel = async (req, res, next) => {
  try {
    const result = await cancelForUser({
      user: req.user,
      source: CancellationSource.user,
    });

    if (result.nothingToCancel) {
      return res.status(404).json({
        status: "Error",
        code: "no_subscription",
        message: "There is no PayPal subscription on this account to cancel.",
      });
    }

    if (!result.ok) {
      if (result.code === "paypal_ownership_unverified") {
        return res.status(403).json({
          status: "Error",
          code: result.code,
          message:
            "We could not confirm this subscription belongs to your account, so we have not cancelled it. Please contact support.",
        });
      }

      // Fail closed, and say what the subscriber can do about it. The retry is
      // safe: nothing has been recorded as cancelled.
      return res.status(503).json({
        status: "Error",
        code: "cancellation_unconfirmed",
        message:
          "We could not confirm with PayPal that your subscription has been cancelled, so nothing has changed. Please try again in a few minutes, or cancel the automatic payment in your PayPal account.",
        retry: true,
        manage_url: PAYPAL_AUTOPAY_URL,
      });
    }

    const [entitlement, record] = await Promise.all([
      Entitlement.findOne({ user_id: req.user._id, platform: "paypal" }),
      PaypalSubscription.findOne({ user_id: req.user._id }),
    ]);

    return res.status(200).json({
      status: "Success",
      // True on the first cancellation and on every repeat of it. A second
      // click is not an error and must not read like one.
      cancelled: true,
      already_cancelled: Boolean(result.alreadyCancelled),
      subscription: buildSubscriptionView(entitlement, record),
      // Refreshed here so the client does not have to make a second call to
      // find out what it is now entitled to.
      entitlement: await resolveEntitlement(req.user),
      feedback_reasons: FEEDBACK_REASONS,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Optional. Accepted only after a cancellation has actually been recorded, so
 * this can never become a step on the way to cancelling.
 */
export const submitCancellationFeedback = async (req, res, next) => {
  try {
    const record = await PaypalSubscription.findOne({ user_id: req.user._id });

    if (!record || !record.cancelled_at) {
      return res.status(409).json({
        status: "Error",
        code: "no_cancellation",
        message: "There is no recent cancellation to give feedback about.",
      });
    }

    const { reason_code: reasonCode, comment } = req.body ?? {};

    if (reasonCode !== undefined && reasonCode !== null && reasonCode !== "") {
      if (typeof reasonCode !== "string" || !FEEDBACK_REASONS.includes(reasonCode)) {
        return res.status(400).json({
          status: "Error",
          code: "invalid_reason",
          message: "That is not one of the offered reasons.",
        });
      }
    }

    if (comment !== undefined && comment !== null && typeof comment !== "string") {
      return res.status(400).json({
        status: "Error",
        code: "invalid_request",
        message: "comment must be text.",
      });
    }

    await CancellationFeedback.findOneAndUpdate(
      { subject_id: req.user.subject_id },
      {
        $set: {
          reason_code: reasonCode || undefined,
          comment: comment ? String(comment).slice(0, MAX_COMMENT_LENGTH) : undefined,
          at: new Date(),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    logger.info("cancellation feedback recorded", { reason_code: reasonCode || "none" });

    return res.status(200).json({ status: "Success", message: "Thank you." });
  } catch (error) {
    return next(error);
  }
};

/**
 * Withdraws consent for the cancellation feedback by deleting it.
 *
 * The feedback is the one thing here held on consent rather than on contract
 * or a legal obligation, so it is the one thing that has to be retractable on
 * demand. Deleting rather than flagging: there is no reason to keep a record
 * that someone once told us why they left and then asked us to forget it.
 *
 * Idempotent. Deleting feedback that is not there is the state the caller
 * wanted, not an error.
 */
export const deleteCancellationFeedback = async (req, res, next) => {
  try {
    const result = await CancellationFeedback.deleteOne({
      subject_id: req.user.subject_id,
    });

    logger.info("cancellation feedback withdrawn", {
      deleted: result.deletedCount ?? 0,
    });

    return res.status(200).json({
      status: "Success",
      deleted: (result.deletedCount ?? 0) > 0,
      message: "Your feedback has been deleted.",
    });
  } catch (error) {
    return next(error);
  }
};
