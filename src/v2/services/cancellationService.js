import { Entitlement } from "../../models/entitlement";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { PendingCancellation } from "../../models/pendingCancellation";
import { AuditLog } from "../../models/auditLog";
import {
  getSubscription,
  cancelSubscription,
  ownershipMatches,
  hasNoBinding,
  subscriptionPhase,
  paidThrough,
} from "./paypalService";
import { recordCancellation } from "./entitlementService";
import { logger } from "../../util/logger";

/**
 * The one place a PayPal subscription is stopped.
 *
 * Account deletion and the subscriber-facing "Cancel Subscription" button both
 * come through here, so there is a single implementation of the parts that are
 * easy to get wrong: proving the subscription belongs to the caller, reading
 * the paid-through date before cancelling rather than after, refusing to claim
 * success on a local write alone, and leaving a durable retry job behind when
 * PayPal will not confirm.
 *
 * The two callers differ only in what they do with the answer. Deletion aborts
 * on an unconfirmed cancellation, because detaching someone from a subscription
 * that is still billing is worse than not deleting; the button just reports it.
 */

export const CancellationSource = {
  user: "user",
  accountDeletion: "account_deletion",
  provider: "provider",
};

const REASONS = {
  [CancellationSource.user]: "Cancelled by subscriber",
  [CancellationSource.accountDeletion]: "Account deleted",
};

const noteFailure = async ({ record, subjectId, source, detail }) => {
  await PendingCancellation.findOneAndUpdate(
    { subscription_id: record.subscription_id },
    {
      $set: {
        provider: "paypal",
        subject_id: subjectId,
        reason: REASONS[source] || "Cancelled by subscriber",
        last_error: String(detail).slice(0, 500),
        last_attempt_at: new Date(),
      },
      $inc: { attempts: 1 },
      $unset: { resolved_at: 1 },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logger.error("paypal cancellation unconfirmed", {
    subscription_id: record.subscription_id,
    source,
    detail: String(detail).slice(0, 200),
  });
};

/**
 * Cancels the authenticated user's PayPal subscription, if they have one.
 *
 * Returns `{ ok: true }` only when PayPal's own record confirms the
 * subscription is no longer billing. A local write is never treated as proof.
 */
export const cancelForUser = async ({ user, source }) => {
  // Scoped to this account from the first query, so the caller cannot even
  // name a subscription that is not theirs.
  const record = await PaypalSubscription.findOne({ user_id: user._id });

  if (!record) {
    return { ok: true, nothingToCancel: true, subscription: null };
  }

  // Idempotent by record, not by request. A second click must not re-read the
  // subscription from PayPal: by then next_billing_time is gone, and deriving
  // the access-end date again would replace a real date with nothing.
  if (record.cancelled_at) {
    return { ok: true, alreadyCancelled: true, subscription: record };
  }

  let subscription;
  try {
    subscription = await getSubscription(record.subscription_id);
  } catch (error) {
    await noteFailure({
      record,
      subjectId: user.subject_id,
      source,
      detail: error.message,
    });
    return { ok: false, code: "cancellation_unconfirmed", detail: error.message };
  }

  // The account link alone already scopes this, but the binding PayPal echoes
  // back is the independent check. Subscriptions claimed through the supervised
  // legacy path never had a binding and proved ownership by email instead - so
  // they are allowed through only while there is still no binding to contradict.
  // A binding naming somebody else is refused whatever the local record says.
  if (subscription && !ownershipMatches(subscription, user.subject_id)) {
    const unboundLegacyClaim = record.legacy_claim && hasNoBinding(subscription);

    if (!unboundLegacyClaim) {
      logger.warn("cancellation refused - ownership not proved", {
        user_id: String(user._id),
        source,
      });
      return { ok: false, code: "paypal_ownership_unverified", detail: "binding does not match" };
    }
  }

  const phase = subscription ? subscriptionPhase(subscription) : record.phase || "unknown";

  // Read before cancelling. During the trial this is the trial's scheduled
  // end; afterwards it is the end of the month already paid for. Either way
  // PayPal stops reporting it the moment the subscription is cancelled.
  const entitlement = await Entitlement.findOne({ user_id: user._id, platform: "paypal" });
  const accessEndsAt =
    (subscription && paidThrough(subscription)) ||
    record.access_ends_at ||
    entitlement?.expires_at ||
    new Date();

  let result;
  if (!subscription) {
    // PayPal has no record at all, so nothing can be billing.
    result = { cancelled: true, confirmed: true, detail: "subscription no longer exists" };
  } else {
    try {
      result = await cancelSubscription(record.subscription_id, REASONS[source]);
    } catch (error) {
      result = { cancelled: false, confirmed: false, detail: error.message };
    }
  }

  if (!result.cancelled) {
    await noteFailure({
      record,
      subjectId: user.subject_id,
      source,
      detail: result.detail,
    });
    return { ok: false, code: "cancellation_unconfirmed", detail: result.detail };
  }

  // Guarded on cancelled_at so two confirmed cancellations racing each other
  // still record one access-end date - the first one, computed while PayPal
  // still reported a next billing time.
  await PaypalSubscription.updateOne(
    { _id: record._id, cancelled_at: { $exists: false } },
    {
      $set: {
        status: "CANCELLED",
        cancelled_at: new Date(),
        cancellation_source: source,
        access_ends_at: accessEndsAt,
        phase,
        updated_at: new Date(),
      },
    }
  );

  await recordCancellation({
    user,
    platform: "paypal",
    accessEndsAt,
    source,
  });

  await PendingCancellation.updateOne(
    { subscription_id: record.subscription_id },
    { $set: { resolved_at: new Date() } }
  );

  await AuditLog.create({
    action: "subscription.cancel",
    user_id: user._id,
    subject_id: user.subject_id,
    detail: { platform: "paypal", source, phase, access_ends_at: accessEndsAt },
  });

  return {
    ok: true,
    cancelled: true,
    phase,
    accessEndsAt,
    subscription: await PaypalSubscription.findById(record._id),
  };
};
