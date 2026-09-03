import jwt from "jsonwebtoken";
import { config } from "../../config/env";
import { RefreshToken } from "../../models/refreshToken";
import { TokenFamily } from "../../models/tokenFamily";
import { randomToken, sha256, hashIp } from "../../util/crypto";
import crypto from "crypto";
import { logger } from "../../util/logger";

const REFRESH_BYTES = 32;

export const issueAccessToken = (user) =>
  jwt.sign(
    {
      sub: String(user._id),
      sid: user.subject_id,
      tv: user.token_version ?? 0,
    },
    config.auth.accessSecret,
    { expiresIn: config.auth.accessTtl, algorithm: "HS256" }
  );

export const verifyAccessToken = (token) =>
  jwt.verify(token, config.auth.accessSecret, { algorithms: ["HS256"] });

const refreshExpiry = () =>
  new Date(Date.now() + config.auth.refreshTtlDays * 24 * 60 * 60 * 1000);

export const issueRefreshToken = async (user, context = {}, familyId = null) => {
  const token = randomToken(REFRESH_BYTES);
  const family = familyId || crypto.randomUUID();

  // The family record is the durable place revocation lives.
  await TokenFamily.findOneAndUpdate(
    { family_id: family },
    { $setOnInsert: { user_id: user._id, created_at: new Date() } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  await RefreshToken.create({
    token_hash: sha256(token),
    user_id: user._id,
    family_id: family,
    expires_at: refreshExpiry(),
    user_agent: context.userAgent,
    ip_hash: hashIp(context.ip),
  });

  return token;
};

export const familyIsRevoked = async (familyId) => {
  const family = await TokenFamily.findOne({ family_id: familyId });
  return Boolean(family && family.revoked_at);
};

export const issueTokenPair = async (user, context = {}) => ({
  access_token: issueAccessToken(user),
  refresh_token: await issueRefreshToken(user, context),
  token_type: "Bearer",
  expires_in: config.auth.accessTtl,
});

export const revokeFamily = async (familyId, reason) => {
  // Family state first: a rotation still in flight checks this before it
  // returns, so a successor landing afterwards cannot resurrect the session.
  await TokenFamily.findOneAndUpdate(
    { family_id: familyId },
    { $set: { revoked_at: new Date(), reason } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  const result = await RefreshToken.updateMany(
    { family_id: familyId, revoked_at: { $exists: false } },
    { $set: { revoked_at: new Date() } }
  );
  logger.warn("refresh token family revoked", {
    family_id: familyId,
    reason,
    revoked: result.modifiedCount,
  });
};

export const revokeAllForUser = async (userId) => {
  await RefreshToken.updateMany(
    { user_id: userId, revoked_at: { $exists: false } },
    { $set: { revoked_at: new Date() } }
  );
};

/**
 * Rotation with reuse detection.
 *
 * The presented token is consumed by an atomic conditional update: only the
 * request whose update matches `revoked_at: { $exists: false }` proceeds, so
 * simultaneous rotations cannot each mint a successor and leave several live
 * tokens behind. Reading first and writing after loses that race.
 *
 * A token that exists but is already revoked normally means the value leaked,
 * so the whole lineage is revoked - the legitimate holder is signed out too,
 * which is the right trade against leaving an attacker with a live session.
 *
 * The exception is a presentation that arrives within a short grace window of
 * the rotation that consumed it. A client with two screens open fires two
 * refreshes at once; punishing that signs real users out for no reason. This
 * does not weaken reuse detection: the single-winner update means a loser
 * receives no token whether it is the real client or an attacker, so the only
 * thing the window decides is whether to destroy the session as well.
 */
export const rotateRefreshToken = async (presented, context = {}) => {
  const presentedHash = sha256(presented);

  // The successor is minted before the token is consumed so that revoked_at
  // and replaced_by can be written by the SAME update. Setting them in two
  // operations leaves a window where the token looks revoked with no
  // successor - indistinguishable from a deliberate revocation - and a loser
  // arriving there would revoke the family the winner just created.
  const next = randomToken(REFRESH_BYTES);
  const nextHash = sha256(next);

  const claimed = await RefreshToken.findOneAndUpdate(
    {
      token_hash: presentedHash,
      revoked_at: { $exists: false },
      expires_at: { $gt: new Date() },
    },
    { $set: { revoked_at: new Date(), replaced_by: nextHash } },
    { new: true }
  );

  // A token whose family is dead is dead, whatever its own row says.
  if (claimed && (await familyIsRevoked(claimed.family_id))) {
    return { ok: false, reason: "reused" };
  }

  if (!claimed) {
    const existing = await RefreshToken.findOne({ token_hash: presentedHash });

    if (!existing) return { ok: false, reason: "unknown" };

    if (existing.revoked_at) {
      const age = Date.now() - existing.revoked_at.getTime();

      // Only a rotation sets replaced_by. Tokens revoked by logout, password
      // reset, or family revocation carry no successor and must stay a hard
      // failure - the grace window is for concurrency, not for reviving a
      // session that was deliberately ended.
      if (existing.replaced_by && age <= config.auth.reuseGraceMs) {
        logger.info("concurrent refresh ignored", { family_id: existing.family_id });
        return { ok: false, reason: "concurrent" };
      }

      await revokeFamily(existing.family_id, "reuse-detected");
      return { ok: false, reason: "reused" };
    }

    return { ok: false, reason: "expired" };
  }

  // A family revoked while this rotation was in flight must not be revived.
  if (await familyIsRevoked(claimed.family_id)) {
    logger.warn("rotation abandoned - family revoked mid-flight", {
      family_id: claimed.family_id,
    });
    return { ok: false, reason: "reused" };
  }

  try {
    await RefreshToken.create({
      token_hash: nextHash,
      user_id: claimed.user_id,
      family_id: claimed.family_id,
      expires_at: refreshExpiry(),
      user_agent: context.userAgent,
      ip_hash: hashIp(context.ip),
    });
  } catch (error) {
    // Compensate: without this a transient write failure would consume the
    // only token the client holds and leave it with nothing to retry with.
    //
    // Deliberately not a multi-document transaction: those require a replica
    // set, and the production topology is unknown (see README). A conditional
    // consume plus a compensating release behaves correctly on a standalone
    // server as well.
    await RefreshToken.updateOne(
      { _id: claimed._id, replaced_by: nextHash },
      { $unset: { revoked_at: 1, replaced_by: 1 } }
    );

    logger.error("refresh rotation rolled back", {
      family_id: claimed.family_id,
      error: error.message,
    });
    throw error;
  }

  // Re-checked after the write. Either the revoker saw this row and revoked
  // it, or it revoked the family before this check and we revoke the row
  // ourselves - so the two orderings converge on the same outcome.
  if (await familyIsRevoked(claimed.family_id)) {
    await RefreshToken.updateOne(
      { token_hash: nextHash, revoked_at: { $exists: false } },
      { $set: { revoked_at: new Date() } }
    );
    logger.warn("successor revoked - family was revoked during rotation", {
      family_id: claimed.family_id,
    });
    return { ok: false, reason: "reused" };
  }

  return { ok: true, userId: claimed.user_id, refreshToken: next };
};
