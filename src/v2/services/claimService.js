import { AppleTransaction } from "../../models/appleTransaction";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { logger } from "../../util/logger";

/**
 * Exclusive claiming of a provider subscription by an account.
 *
 * Check-then-act loses a race: two requests both read the record as unowned,
 * both write, and the later one silently takes ownership. Instead the filter
 * itself carries the condition - unowned, or already ours - so the update is
 * the check. A losing writer misses the filter, upserts, and collides with
 * the unique index, which is how we learn we lost.
 */
const claimExclusively = async (Model, idField, idValue, userId, fields) => {
  try {
    const doc = await Model.findOneAndUpdate(
      {
        [idField]: idValue,
        $or: [{ user_id: { $exists: false } }, { user_id: null }, { user_id: userId }],
      },
      { $set: { user_id: userId, ...fields } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return { ok: true, doc };
  } catch (error) {
    // 11000 duplicate key: the record exists and belongs to somebody else.
    if (error.code === 11000) {
      logger.warn("exclusive claim lost", { model: Model.modelName, id: idValue });
      return { ok: false, reason: "already_claimed" };
    }
    throw error;
  }
};

export const claimAppleTransaction = (originalTransactionId, userId, fields) =>
  claimExclusively(
    AppleTransaction,
    "original_transaction_id",
    originalTransactionId,
    userId,
    fields
  );

export const claimPaypalSubscription = (subscriptionId, userId, fields) =>
  claimExclusively(
    PaypalSubscription,
    "subscription_id",
    subscriptionId,
    userId,
    fields
  );
