import { logger } from "../../util/logger";

/**
 * Single-use codes that must survive a failure part-way through.
 *
 * Marking a code used and then doing the work loses the code whenever the
 * work fails: the password is unchanged but the reset link is spent, the
 * subscription is unclaimed but the confirmation code is gone. Instead a
 * processor takes a short lease, does the work, and only then marks the code
 * used - releasing the lease if anything goes wrong.
 *
 * Deliberately not a multi-document transaction: those need a replica set and
 * the production topology is unknown (see README). A conditional claim plus an
 * explicit release behaves correctly on a standalone server too.
 */
export const LEASE_MS = 60 * 1000;

const leaseIsFree = (staleBefore) => [
  { processing_started_at: { $exists: false } },
  { processing_started_at: null },
  { processing_started_at: { $lte: staleBefore } },
];

/** Takes the lease, or returns null if the code is spent, expired or in use. */
export const claimWithLease = async (Model, filter, leaseMs = LEASE_MS) => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - leaseMs);

  return Model.findOneAndUpdate(
    { ...filter, $or: leaseIsFree(staleBefore) },
    { $set: { processing_started_at: now } },
    { new: true }
  );
};

/** Marks the work done. The code is now spent. */
export const settleLease = (Model, id, field) =>
  Model.updateOne(
    { _id: id },
    { $set: { [field]: new Date() }, $unset: { processing_started_at: 1 } }
  );

/** Gives the code back so the caller can try again. */
export const releaseLease = async (Model, id, error) => {
  await Model.updateOne({ _id: id }, { $unset: { processing_started_at: 1 } });
  if (error) {
    logger.warn("released single-use code after failure", {
      model: Model.modelName,
      error: error.message,
    });
  }
};
