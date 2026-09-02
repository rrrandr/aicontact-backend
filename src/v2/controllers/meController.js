import bcrypt from "bcryptjs";
import crypto from "crypto";
import { User } from "../../models/user";
import { Entitlement } from "../../models/entitlement";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { AppleTransaction } from "../../models/appleTransaction";
import { AuditLog } from "../../models/auditLog";
import { hashIp } from "../../util/crypto";
import { revokeAllForUser } from "../services/tokenService";
import { cancelSubscription } from "../services/paypalService";
import { PendingCancellation } from "../../models/pendingCancellation";
import { publicUser } from "./authController";
import { logger } from "../../util/logger";

export const getMe = async (req, res, next) => {
  try {
    return res.status(200).json({
      status: "Success",
      user: await publicUser(req.user),
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Terms acceptance is the only writable field.
 *
 * Entitlement fields are rejected outright rather than ignored, so a client
 * sending them gets told rather than quietly believing it succeeded.
 */
export const patchMe = async (req, res, next) => {
  try {
    const forbidden = ["subscription_date", "entitlement", "status", "token_version"];
    const attempted = forbidden.filter((field) => field in (req.body ?? {}));

    if (attempted.length) {
      return res.status(403).json({
        status: "Error",
        code: "field_not_writable",
        message: `These fields are set by the server and cannot be changed: ${attempted.join(", ")}.`,
      });
    }

    if (typeof req.body?.terms_accepted !== "boolean") {
      return res.status(400).json({
        status: "Error",
        code: "invalid_request",
        message: "terms_accepted must be true or false.",
      });
    }

    req.user.terms_accepted = req.body.terms_accepted ? "true" : "false";
    req.user.terms_accepted_at = req.body.terms_accepted ? new Date() : undefined;
    await req.user.save();

    return res.status(200).json({
      status: "Success",
      user: await publicUser(req.user),
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Account deletion, as required by App Store Guideline 5.1.1(v).
 *
 * The password is required again: an unattended device must not be able to
 * destroy an account.
 *
 * Personal data goes immediately. Financial records are kept, re-keyed to the
 * pseudonymous subject_id, because deleting proof of purchase would leave
 * refunds and chargebacks unanswerable. Retention windows are configured, not
 * hardcoded, and still need legal sign-off.
 */
export const deleteMe = async (req, res, next) => {
  try {
    const { password } = req.body ?? {};

    if (typeof password !== "string" || !(await bcrypt.compare(password, req.user.password))) {
      return res.status(401).json({
        status: "Error",
        code: "invalid_credentials",
        message: "Please re-enter your password to delete your account.",
      });
    }

    const user = req.user;
    const subjectId = user.subject_id;

    // Cancel any PayPal subscription we manage, and confirm it actually
    // stopped, BEFORE anything is destroyed.
    //
    // Completing the deletion while billing continues is the worst available
    // outcome: the person is detached from the subscription and can no longer
    // sign in to stop it. So an unconfirmed cancellation aborts the deletion
    // and leaves a durable job behind, rather than proceeding hopefully.
    const paypal = await PaypalSubscription.findOne({ user_id: user._id });
    let paypalCancelled = false;

    if (paypal) {
      let result;
      try {
        result = await cancelSubscription(paypal.subscription_id, "Account deleted");
      } catch (error) {
        result = { cancelled: false, confirmed: false, detail: error.message };
      }

      if (!result.cancelled) {
        await PendingCancellation.findOneAndUpdate(
          { subscription_id: paypal.subscription_id },
          {
            $set: {
              provider: "paypal",
              subject_id: subjectId,
              reason: "account deletion",
              last_error: String(result.detail).slice(0, 500),
              last_attempt_at: new Date(),
            },
            $inc: { attempts: 1 },
            $setOnInsert: { created_at: new Date() },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        logger.error("aborting deletion - paypal cancellation unconfirmed", {
          subscription_id: paypal.subscription_id,
          detail: result.detail,
        });

        return res.status(503).json({
          status: "Error",
          code: "cancellation_unconfirmed",
          message:
            "We could not confirm with PayPal that your subscription has stopped, so we have not deleted your account yet. Please try again shortly, or cancel the subscription in PayPal first.",
        });
      }

      paypalCancelled = true;
      await PendingCancellation.updateOne(
        { subscription_id: paypal.subscription_id },
        { $set: { resolved_at: new Date() } }
      );
    }

    const hadAppleSubscription = await AppleTransaction.exists({ user_id: user._id });

    // Detach retained records from the account and keep them against the
    // pseudonymous identifier alone.
    // $unset must use 1, not "": Mongoose casts the value against the path's
    // type and silently drops an empty string on an ObjectId field, which
    // would leave the account id attached to records we intend to keep.
    await Entitlement.updateMany(
      { user_id: user._id },
      { $set: { subject_id: subjectId, status: "revoked" }, $unset: { user_id: 1 } }
    );
    await AppleTransaction.updateMany({ user_id: user._id }, { $unset: { user_id: 1 } });
    await PaypalSubscription.updateMany({ user_id: user._id }, { $unset: { user_id: 1 } });

    await revokeAllForUser(user._id);

    // Tombstone rather than remove, so the unique index still prevents the
    // address being silently re-registered onto old records.
    user.email = `deleted+${crypto.randomBytes(12).toString("hex")}@deleted.invalid`;
    user.email_norm = user.email;
    user.password = crypto.randomBytes(32).toString("hex");
    user.subscription_date = "";
    user.terms_accepted = "false";
    user.terms_accepted_at = undefined;
    user.status = "deleted";
    user.deleted_at = new Date();
    user.token_version = (user.token_version ?? 0) + 1;
    await user.save();

    await AuditLog.create({
      action: "account.delete",
      subject_id: subjectId,
      detail: {
        paypal_cancelled: paypalCancelled,
        apple_subscription_present: Boolean(hadAppleSubscription),
      },
      ip_hash: hashIp(req.ip),
    });

    return res.status(200).json({
      status: "Success",
      message: "Your account has been deleted.",
      // Apple manages its own subscriptions; deleting an account does not
      // stop billing, and the app must tell the user so.
      apple_subscription_requires_manual_cancellation: Boolean(hadAppleSubscription),
      paypal_subscription_cancelled: paypalCancelled,
    });
  } catch (error) {
    return next(error);
  }
};
