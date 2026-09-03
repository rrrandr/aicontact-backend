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
  revokeFamilyForToken,
  issueAccessToken,
} from "../services/tokenService";
import { RefreshToken } from "../../models/refreshToken";
import { sendPasswordReset } from "../services/mailService";
import { resolveEntitlement } from "../services/entitlementService";
import { logger } from "../../util/logger";
import { claimWithLease, settleLease, releaseLease } from "../services/leaseService";

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
    //
    // Written with a conditional update rather than saving the document we
    // are holding. A password reset landing between the read above and this
    // write would otherwise be undone: saving the in-memory document writes
    // the OLD password back, resurrecting a credential that was just
    // replaced. The condition means the upgrade applies only while the stored
    // hash is still the one we verified against.
    const observedHash = user.password;
    const observedCost = Number(observedHash.split("$")[2]);

    if (Number.isFinite(observedCost) && observedCost < config.auth.bcryptCost) {
      await User.updateOne(
        { _id: user._id, password: observedHash },
        {
          $set: {
            password: await bcrypt.hash(password, config.auth.bcryptCost),
            password_updated_at: new Date(),
          },
        }
      );
    }

    // Backfill for accounts that predate v2.
    if (!user.subject_id) {
      const subjectId = newSubjectId();
      await User.updateOne(
        {
          _id: user._id,
          $or: [{ subject_id: { $exists: false } }, { subject_id: null }, { subject_id: "" }],
        },
        { $set: { subject_id: subjectId } }
      );
      user.subject_id = subjectId;
    }

    // Tokens are deliberately issued from the account state this login
    // actually authenticated against. Re-reading here would let a login that
    // verified a superseded password pick up the new credential generation
    // and mint a valid session; instead its family records the old
    // generation and is refused on first use.

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
      if (result.reason === "concurrent") {
        // Another request rotated this token a moment ago. The session is
        // intact; the caller should use the token that rotation returned.
        return res.status(409).json({
          status: "Error",
          code: "refresh_in_progress",
          message: "This token was just refreshed. Use the most recent token.",
        });
      }

      return res.status(401).json({
        status: "Error",
        code: result.reason === "reused" ? "token_reused" : "invalid_refresh_token",
        message:
          result.reason === "reused"
            ? "This session has been ended for security reasons. Please sign in again."
            : "Refresh token is invalid or expired.",
      });
    }

    // Signed from the snapshot rotation validated the family against. The
    // account is deliberately NOT re-read here: doing so would rebase the
    // session onto whatever generation exists by then, handing a token
    // carrying the new token_version to a session whose family was revoked
    // between rotation's last check and this point.
    return res.status(200).json({
      status: "Success",
      access_token: issueAccessToken(result.user),
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
      // The whole family, not just this row. If a rotation has already
      // consumed the presented token, revoking that row alone does nothing
      // and its successor stays usable.
      await revokeFamilyForToken(presented, "logout");
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
      token_version_at_issue: user.token_version ?? 0,
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

    // Claimed under a lease rather than marked used up front: simultaneous
    // requests still cannot both proceed, but a failure before the password
    // is actually changed gives the code back instead of spending it.
    const record = await claimWithLease(PasswordReset, {
      token_hash: sha256(token),
      used_at: { $exists: false },
      expires_at: { $gt: new Date() },
    });

    if (!record) {
      return res.status(400).json({
        status: "Error",
        code: "invalid_reset_token",
        message: "This reset link is invalid or has expired.",
      });
    }

    const tokenHash = sha256(token);
    let updated;

    try {
      const hashed = await bcrypt.hash(password, config.auth.bcryptCost);

      // The User document guards itself. The reset record's lease coordinates
      // the workflow, but it protects a DIFFERENT document - a worker whose
      // lease went stale could otherwise still write a password here. This
      // condition is what makes only one write land: after the winner, the
      // marker equals this token, so no second update can match.
      // Bound to the credential generation this link was issued under. Any
      // successful reset increments token_version, so every sibling link
      // becomes stale the moment one of them is used - in either order, and
      // without inferring ordering from millisecond timestamps. The
      // timestamp condition is kept as a secondary guard, and for records
      // issued before this field existed.
      const generationGuard =
        record.token_version_at_issue === undefined ||
        record.token_version_at_issue === null
          ? {}
          : { token_version: record.token_version_at_issue };

      updated = await User.findOneAndUpdate(
        {
          _id: record.user_id,
          status: "active",
          password_reset_token_hash: { $ne: tokenHash },
          ...generationGuard,
          $or: [
            { password_updated_at: { $exists: false } },
            { password_updated_at: null },
            { password_updated_at: { $lte: record.created_at } },
          ],
        },
        {
          $set: {
            password: hashed,
            password_updated_at: new Date(),
            password_reset_token_hash: tokenHash,
          },
          // Invalidates every access token already issued for this account.
          $inc: { token_version: 1 },
        },
        { new: true }
      );
    } catch (error) {
      // Nothing changed, so the code goes back.
      await releaseLease(PasswordReset, record._id, record.lease_token, error);
      throw error;
    }

    if (!updated) {
      // Either this token already set the password, or the account is gone.
      // Both mean the code is spent.
      await settleLease(PasswordReset, record._id, "used_at", record.lease_token);
      return res.status(400).json({
        status: "Error",
        code: "invalid_reset_token",
        message: "This reset link is invalid or has expired.",
      });
    }

    // Past this point the password HAS changed. The code is never released
    // again, whatever else fails - the marker above enforces that even if
    // this settle does not land.
    await settleLease(PasswordReset, record._id, "used_at", record.lease_token);

    // Belt and braces alongside the time condition above: no outstanding link
    // for this account survives a successful reset.
    try {
      await PasswordReset.updateMany(
        { user_id: updated._id, used_at: { $exists: false } },
        { $set: { used_at: new Date() }, $unset: { processing_started_at: 1, lease_token: 1 } }
      );
    } catch (error) {
      logger.error("failed to invalidate outstanding reset links", {
        error: error.message,
      });
    }

    try {
      await revokeAllForUser(updated._id, "password-reset");
      await AuditLog.create({
        action: "account.password_reset",
        user_id: updated._id,
        subject_id: updated.subject_id,
        ip_hash: hashIp(req.ip),
      });
    } catch (error) {
      // Best effort. token_version was already bumped in the write above, so
      // existing access tokens are dead regardless.
      logger.error("post-reset cleanup failed", { error: error.message });
    }

    return res.status(200).json({
      status: "Success",
      message: "Password updated. Please sign in again.",
    });
  } catch (error) {
    return next(error);
  }
};
