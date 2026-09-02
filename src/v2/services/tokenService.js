import jwt from "jsonwebtoken";
import { config } from "../../config/env";
import { RefreshToken } from "../../models/refreshToken";
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

  await RefreshToken.create({
    token_hash: sha256(token),
    user_id: user._id,
    family_id: familyId || crypto.randomUUID(),
    expires_at: refreshExpiry(),
    user_agent: context.userAgent,
    ip_hash: hashIp(context.ip),
  });

  return token;
};

export const issueTokenPair = async (user, context = {}) => ({
  access_token: issueAccessToken(user),
  refresh_token: await issueRefreshToken(user, context),
  token_type: "Bearer",
  expires_in: config.auth.accessTtl,
});

export const revokeFamily = async (familyId, reason) => {
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
 * A refresh token is single use. Being presented one that has already been
 * rotated means the value leaked, so every token in its lineage is revoked -
 * the legitimate holder is signed out too, which is the correct outcome when
 * the alternative is leaving an attacker with a valid session.
 */
export const rotateRefreshToken = async (presented, context = {}) => {
  const stored = await RefreshToken.findOne({ token_hash: sha256(presented) });

  if (!stored) return { ok: false, reason: "unknown" };

  if (stored.revoked_at) {
    await revokeFamily(stored.family_id, "reuse-detected");
    return { ok: false, reason: "reused" };
  }

  if (stored.expires_at.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const next = randomToken(REFRESH_BYTES);
  const nextHash = sha256(next);

  await RefreshToken.create({
    token_hash: nextHash,
    user_id: stored.user_id,
    family_id: stored.family_id,
    expires_at: refreshExpiry(),
    user_agent: context.userAgent,
    ip_hash: hashIp(context.ip),
  });

  stored.revoked_at = new Date();
  stored.replaced_by = nextHash;
  await stored.save();

  return { ok: true, userId: stored.user_id, refreshToken: next };
};
