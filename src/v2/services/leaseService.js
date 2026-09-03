import { randomToken } from "../../util/crypto";
import { logger } from "../../util/logger";

/**
 * Fenced leases over single-use records.
 *
 * Marking a code used and then doing the work loses the code whenever the
 * work fails: the password is unchanged but the reset link is spent. So a
 * processor takes a lease, does the work, and settles afterwards.
 *
 * A lease recorded only as a timestamp cannot tell its holders apart. Once it
 * goes stale and a second worker takes over, the first can still wake up and
 * settle or release - marking someone else's work done, or clearing an active
 * lease out from under them. Every acquisition therefore carries a random
 * token, and every later write has to present it.
 *
 * Deliberately not a multi-document transaction: the production deployment is
 * a standalone mongod (single-host mongodb:// with no replicaSet option), so
 * transactions are unavailable. Fencing gives the same safety for this shape
 * of work.
 */
export const LEASE_MS = 60 * 1000;

const leaseIsFree = (staleBefore) => [
  { processing_started_at: { $exists: false } },
  { processing_started_at: null },
  { processing_started_at: { $lte: staleBefore } },
];

/**
 * Takes the lease, or returns null if the record is spent, expired, or held
 * by a live worker. The returned document carries the lease_token that later
 * writes must present.
 */
export const claimWithLease = async (Model, filter, leaseMs = LEASE_MS) => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - leaseMs);
  const leaseToken = randomToken(16);

  return Model.findOneAndUpdate(
    { ...filter, $or: leaseIsFree(staleBefore) },
    { $set: { processing_started_at: now, lease_token: leaseToken } },
    { new: true }
  );
};

/**
 * Marks the work done. Only the current holder may do so, so a stale worker
 * cannot declare its successor's work complete.
 */
export const settleLease = async (Model, id, field, leaseToken) => {
  const result = await Model.updateOne(
    { _id: id, lease_token: leaseToken },
    { $set: { [field]: new Date() }, $unset: { processing_started_at: 1, lease_token: 1 } }
  );

  const settled = (result.modifiedCount ?? 0) > 0;
  if (!settled) {
    logger.warn("stale worker tried to settle a lease it no longer holds", {
      model: Model.modelName,
    });
  }
  return settled;
};

/**
 * Gives the record back so it can be retried. Only the current holder may do
 * so, so a stale worker cannot clear an active lease.
 */
export const releaseLease = async (Model, id, leaseToken, error) => {
  const result = await Model.updateOne(
    { _id: id, lease_token: leaseToken },
    { $unset: { processing_started_at: 1, lease_token: 1 } }
  );

  const released = (result.modifiedCount ?? 0) > 0;

  if (error) {
    logger.warn("released single-use record after failure", {
      model: Model.modelName,
      released,
      error: error.message,
    });
  } else if (!released) {
    logger.warn("stale worker tried to release a lease it no longer holds", {
      model: Model.modelName,
    });
  }

  return released;
};
