import bcrypt from "bcryptjs";
import crypto from "crypto";
import { User } from "../../models/user";
import { Entitlement } from "../../models/entitlement";
import { PaypalSubscription } from "../../models/paypalSubscription";
import { AppleTransaction } from "../../models/appleTransaction";
import { AuditLog } from "../../models/auditLog";
import { revokeAllForUser } from "../services/tokenService";
import { cancelForUser, CancellationSource } from "../services/cancellationService";
import { publicUser } from "./authController";
import { ConsentRecord } from "../../models/consentRecord";
import { CancellationFeedback } from "../../models/cancellationFeedback";
import { CustomerMessage } from "../../models/customerMessage";
import {
  CURRENT_DOCUMENT_VERSIONS,
  DOCUMENTS,
  REQUIRED_TO_PROCEED,
  REQUIRED_FOR_CAMERA,
} from "../legalDocuments";
import { logger } from "../../util/logger";

/**
 * Which documents this account has not accepted at their current version.
 *
 * Computed rather than stored, so bumping a version in legalDocuments.js is
 * all it takes to ask everyone again. A withdrawn acknowledgement counts as
 * not accepted, which is how withdrawing camera consent re-closes the camera.
 */
export const outstandingConsents = async (user) => {
  const accepted = await ConsentRecord.find({
    user_id: user._id,
    withdrawn_at: { $exists: false },
  });

  const current = new Set(
    accepted
      .filter((row) => row.version === CURRENT_DOCUMENT_VERSIONS[row.document])
      .map((row) => row.document)
  );

  return DOCUMENTS.filter((document) => !current.has(document)).map((document) => ({
    document,
    version: CURRENT_DOCUMENT_VERSIONS[document],
    blocks_use: REQUIRED_TO_PROCEED.includes(document),
    blocks_camera: document === REQUIRED_FOR_CAMERA,
  }));
};

export const getMe = async (req, res, next) => {
  try {
    return res.status(200).json({
      status: "Success",
      user: await publicUser(req.user),
      // The client cannot let someone past the acceptance screens, or open the
      // camera, while anything here still applies.
      required_consents: await outstandingConsents(req.user),
    });
  } catch (error) {
    return next(error);
  }
};

const MAX_STATEMENT = 500;

/**
 * Records acceptance of one or more documents.
 *
 * Idempotent by (account, document, version): submitting the same acceptance
 * twice records it once and succeeds both times, so a client that retries
 * after a dropped reply is not punished for it.
 */
export const recordConsent = async (req, res, next) => {
  try {
    const submitted = req.body?.documents;

    if (!Array.isArray(submitted) || submitted.length === 0) {
      return res.status(400).json({
        status: "Error",
        code: "invalid_request",
        message: "documents must be a non-empty array.",
      });
    }

    for (const entry of submitted) {
      const document = entry?.document;
      const version = entry?.version;

      if (!DOCUMENTS.includes(document)) {
        return res.status(400).json({
          status: "Error",
          code: "unknown_document",
          message: `${document} is not a document we ask you to accept.`,
        });
      }

      // The version the client displayed has to be the one in force. Accepting
      // a version we no longer publish is not an acceptance of what is on
      // screen now, and recording it would misstate what the person agreed to.
      if (version !== CURRENT_DOCUMENT_VERSIONS[document]) {
        return res.status(409).json({
          status: "Error",
          code: "stale_document_version",
          message: "This document has been updated. Please reopen it and read the current version.",
          document,
          current_version: CURRENT_DOCUMENT_VERSIONS[document],
        });
      }
    }

    for (const entry of submitted) {
      try {
        await recordOne(req.user, entry);
      } catch (error) {
        // Duplicate key: an identical submission won the race. That is the
        // same fact arriving twice, not a failure, and answering 500 to a
        // request that succeeded would make a client retry forever.
        if (error.code !== 11000) throw error;
      }
    }

    // Kept in step so released v1 clients, which read this field, still behave.
    if (submitted.some((entry) => entry.document === "terms")) {
      req.user.terms_accepted = "true";
      req.user.terms_accepted_at = new Date();
      await req.user.save();
    }

    return res.status(200).json({
      status: "Success",
      required_consents: await outstandingConsents(req.user),
    });
  } catch (error) {
    return next(error);
  }
};

const recordOne = (user, entry) =>
  ConsentRecord.findOneAndUpdate(
        { user_id: user._id, document: entry.document, version: entry.version },
    {
      $setOnInsert: {
        subject_id: user.subject_id,
        statement: entry.statement
          ? String(entry.statement).slice(0, MAX_STATEMENT)
          : undefined,
        client_version: entry.client_version
          ? String(entry.client_version).slice(0, 64)
          : undefined,
        platform: entry.platform ? String(entry.platform).slice(0, 64) : undefined,
        accepted_at: new Date(),
      },
      $unset: { withdrawn_at: 1 },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

/**
 * Withdraws an acknowledgement. Only the camera notice can be withdrawn while
 * keeping an account: withdrawing the terms is what deleting the account is
 * for.
 */
export const withdrawConsent = async (req, res, next) => {
  try {
    const document = req.body?.document;

    if (document !== REQUIRED_FOR_CAMERA) {
      return res.status(400).json({
        status: "Error",
        code: "not_withdrawable",
        message:
          "Only the camera notice can be withdrawn here. To withdraw the terms, delete your account.",
      });
    }

    await ConsentRecord.updateMany(
      { user_id: req.user._id, document, withdrawn_at: { $exists: false } },
      { $set: { withdrawn_at: new Date() } }
    );

    await AuditLog.create({
      action: "consent.withdrawn",
      user_id: req.user._id,
      subject_id: req.user.subject_id,
      detail: { document },
    });

    return res.status(200).json({
      status: "Success",
      required_consents: await outstandingConsents(req.user),
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
    //
    // The same guarded path the Cancel Subscription button uses. Deletion is
    // not a kind of cancellation and cancellation is not a kind of deletion,
    // but stopping the billing is one job and there is one implementation of it.
    const cancellation = await cancelForUser({
      user,
      source: CancellationSource.accountDeletion,
    });

    if (!cancellation.ok) {
      logger.error("aborting deletion - paypal cancellation unconfirmed", {
        code: cancellation.code,
        detail: String(cancellation.detail).slice(0, 200),
      });

      return res.status(503).json({
        status: "Error",
        code: "cancellation_unconfirmed",
        message:
          "We could not confirm with PayPal that your subscription has stopped, so we have not deleted your account yet. Please try again shortly, or cancel the subscription in PayPal first.",
      });
    }

    const paypalCancelled = !cancellation.nothingToCancel;

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

    // Detached and kept, like the financial records and for the same reason:
    // evidence of what was agreed, and evidence that a notice we were required
    // to send was sent, both have to outlive the account they concern. Neither
    // carries anything about the person beyond the pseudonymous identifier.
    await ConsentRecord.updateMany(
      { user_id: user._id },
      { $set: { subject_id: subjectId }, $unset: { user_id: 1 } }
    );
    await CustomerMessage.updateMany(
      { user_id: user._id },
      { $set: { subject_id: subjectId }, $unset: { user_id: 1 } }
    );

    // Cancellation feedback goes, rather than being detached and kept.
    //
    // Unlike the financial records, it is held on consent alone and there is
    // no obligation to retain it. Someone deleting their account is
    // withdrawing every consent they gave, and keeping their explanation of
    // why they left - against an identifier we could still match to the rest
    // of what we kept - would be exactly the thing the deletion was for.
    await CancellationFeedback.deleteMany({ subject_id: subjectId });

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
