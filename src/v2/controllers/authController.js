import bcrypt from "bcryptjs";
import { User } from "../../models/user";
import { PasswordReset } from "../../models/passwordReset";
import { AuditLog } from "../../models/auditLog";
import { config } from "../../config/env";
import { isValidEmail, normalizeEmail } from "../../util/email";
import { randomToken, sha256, hashIp, newSubjectId } from "../../util/crypto";
import { requirePassword, requireString, ValidationError } from "../middleware/validate";
import {
  issueTokenPair,
  rotateRefreshToken,
  revokeAllForUser,
  issueAccessToken,
} from "../services/tokenService";
import { RefreshToken } from "../../models/refreshToken";
import { sendPasswordReset } from "../services/mailService";
import { resolveEntitlement } from "../services/entitlementService";
import { logger } from "../../util/logger";

const RESET_TTL_MS = 30 * 60 * 1000;

const context = (req) => ({
  ip: req.ip,
  userAgent: req.get("user-agent"),
});

export const publicUser = async (user) => ({
  id: String(user._id),
  email: user.email,
  terms_accepted: user.terms_accepted === "true",
  terms_accepted_at: user.terms_accepted_at
    ? user.terms_accepted_at.toISOString()
    : null,
  created_at: user._id.getTimestamp().toISOString(),
  entitlement: await resolveEntitlement(user),
});

const findActiveByEmail = (email) =>
  User.findOne({ email_norm: normalizeEmail(email), status: "active" });

export const register = async (req, res, next) => {
  try {
    const email = requireString(req.body?.email, "email", { max: 254 });
    const password = requirePassword(req.body?.password);

    if (!isValidEmail(email)) {
      throw new ValidationError("Please provide a valid email address", "email");
    }

    const existing = await findActiveByEmail(email);
    if (existing) {
      return res.status(409).json({
        status: "Error",
        code: "email_in_use",
        message: "That email address is already registered.",
      });
    }

    const hash = await bcrypt.hash(password, config.auth.bcryptCost);

    const user = await User.create({
      email,
      email_norm: normalizeEmail(email),
      password: hash,
      password_updated_at: new Date(),
      subject_id: newSubjectId(),
      terms_accepted: req.body?.terms_accepted === true ? "true" : "false",
      terms_accepted_at: req.body?.terms_accepted === true ? new Date() : undefined,
      status: "active",
    });

    await AuditLog.create({
      action: "account.register",
      user_id: user._id,
      subject_id: user.subject_id,
      ip_hash: hashIp(req.ip),
    });

    return res.status(201).json({
      status: "Success",
      user: await publicUser(user),
      ...(await issueTokenPair(user, context(req))),
    });
  } catch (error) {
    return next(error);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    const invalid = () =>
      res.status(401).json({
        status: "Error",
        code: "invalid_credentials",
        message: "Email address or password is incorrect.",
      });

    if (typeof email !== "string" || typeof password !== "string") return invalid();

    const user = await findActiveByEmail(email);
    if (!user) {
      // Spend comparable time on a miss so response timing does not reveal
      // whether the address is registered.
      await bcrypt.compare(password, "$2a$12$" + "x".repeat(53));
      return invalid();
    }

    if (!(await bcrypt.compare(password, user.password))) return invalid();

    // Transparent rehash. Accounts created under v1 carry cost-10 hashes;
    // there is no reason to force a reset when the plaintext is in hand.
    const cost = Number(user.password.split("$")[2]);
    if (Number.isFinite(cost) && cost < config.auth.bcryptCost) {
      user.password = await bcrypt.hash(password, config.auth.bcryptCost);
      user.password_updated_at = new Date();
    }

    // Backfill for accounts that predate v2.
    if (!user.subject_id) user.subject_id = newSubjectId();
    await user.save();

    return res.status(200).json({
      status: "Success",
      user: await publicUser(user),
      ...(await issueTokenPair(user, context(req))),
    });
  } catch (error) {
    return next(error);
  }
};

export const refresh = async (req, res, next) => {
  try {
    const presented = requireString(req.body?.refresh_token, "refresh_token");
    const result = await rotateRefreshToken(presented, context(req));

    if (!result.ok) {
      return res.status(401).json({
        status: "Error",
        code: result.reason === "reused" ? "token_reused" : "invalid_refresh_token",
        message:
          result.reason === "reused"
            ? "This session has been ended for security reasons. Please sign in again."
            : "Refresh token is invalid or expired.",
      });
    }

    const user = await User.findById(result.userId);
    if (!user || user.status !== "active") {
      return res.status(401).json({
        status: "Error",
        code: "invalid_refresh_token",
        message: "Refresh token is invalid or expired.",
      });
    }

    return res.status(200).json({
      status: "Success",
      access_token: issueAccessToken(user),
      refresh_token: result.refreshToken,
      token_type: "Bearer",
      expires_in: config.auth.accessTtl,
    });
  } catch (error) {
    return next(error);
  }
};

export const logout = async (req, res, next) => {
  try {
    const presented = req.body?.refresh_token;
    if (typeof presented === "string" && presented) {
      await RefreshToken.updateOne(
        { token_hash: sha256(presented), revoked_at: { $exists: false } },
        { $set: { revoked_at: new Date() } }
      );
    }
    // Always succeeds. Whether the token existed is not the caller's business.
    return res.status(200).json({ status: "Success" });
  } catch (error) {
    return next(error);
  }
};

export const forgotPassword = async (req, res, next) => {
  try {
    const email = req.body?.email;

    // Always the same answer, so this cannot be used to test which addresses
    // are registered.
    const accepted = () =>
      res.status(202).json({
        status: "Success",
        message: "If that address has an account, a reset link is on its way.",
      });

    if (typeof email !== "string" || !isValidEmail(email)) return accepted();

    const user = await findActiveByEmail(email);
    if (!user) return accepted();

    const token = randomToken(32);
    await PasswordReset.create({
      token_hash: sha256(token),
      user_id: user._id,
      expires_at: new Date(Date.now() + RESET_TTL_MS),
    });

    try {
      await sendPasswordReset({ to: user.email, token });
    } catch (error) {
      logger.error("password reset email failed", { error: error.message });
    }

    return accepted();
  } catch (error) {
    return next(error);
  }
};

export const resetPassword = async (req, res, next) => {
  try {
    const token = requireString(req.body?.token, "token");
    const password = requirePassword(req.body?.password);

    const record = await PasswordReset.findOne({ token_hash: sha256(token) });

    if (!record || record.used_at || record.expires_at.getTime() <= Date.now()) {
      return res.status(400).json({
        status: "Error",
        code: "invalid_reset_token",
        message: "This reset link is invalid or has expired.",
      });
    }

    const user = await User.findById(record.user_id);
    if (!user || user.status !== "active") {
      return res.status(400).json({
        status: "Error",
        code: "invalid_reset_token",
        message: "This reset link is invalid or has expired.",
      });
    }

    user.password = await bcrypt.hash(password, config.auth.bcryptCost);
    user.password_updated_at = new Date();
    // Invalidates every access token already issued for this account.
    user.token_version = (user.token_version ?? 0) + 1;
    await user.save();

    record.used_at = new Date();
    await record.save();

    await revokeAllForUser(user._id);

    await AuditLog.create({
      action: "account.password_reset",
      user_id: user._id,
      subject_id: user.subject_id,
      ip_hash: hashIp(req.ip),
    });

    return res.status(200).json({
      status: "Success",
      message: "Password updated. Please sign in again.",
    });
  } catch (error) {
    return next(error);
  }
};
