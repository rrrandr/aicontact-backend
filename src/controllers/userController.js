import bcrypt from "bcryptjs";
import { User, PUBLIC_FIELDS } from "../models/user";
import { EntitlementAudit } from "../models/entitlementAudit";
import { isValidEmail, normalizeEmail } from "../util/email";
import { logger } from "../util/logger";
import { legacyWritesLocked } from "../v2/services/entitlementService";

/**
 * v1 controllers. Two released applications depend on these response bodies,
 * so every success payload here - including its typos - is preserved verbatim.
 * See tests/contract for the assertions that hold this contract in place.
 */

// Exact match first, so behaviour is unchanged for any row the backfill has
// not reached yet; the normalized index is only consulted as a fallback. This
// can only ever find more users than the original lookup, never fewer.
const findByEmail = async (rawEmail, projection = PUBLIC_FIELDS) => {
  if (typeof rawEmail !== "string" || !rawEmail) return null;

  const exact = await User.findOne({ email: rawEmail }).select(projection);
  if (exact) return exact;

  const norm = normalizeEmail(rawEmail);
  if (!norm) return null;

  return User.findOne({ email_norm: norm }).select(projection);
};

// Register User
export const createUser = async (req, res, next) => {
  try {
    const { email, password, terms_accepted } = req.body ?? {};

    if (!isValidEmail(email)) {
      return res.status(400).json({
        code: 400,
        status: "Error",
        message: "Please fill a valid email address",
      });
    }

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        code: 400,
        status: "Error",
        message: "Password must be at least 8 characters.",
      });
    }

    const findUser = await findByEmail(email);
    if (findUser) {
      return res.status(400).json({
        code: 400,
        status: "Error",
        message: "Email address already exists!",
      });
    }

    const salt = await bcrypt.genSalt(10);

    // Whitelist. The previous implementation passed the raw request body to
    // User.create, so a client could set subscription_date at signup and
    // grant itself a paid entitlement.
    const user = await User.create({
      email: email.trim(),
      email_norm: normalizeEmail(email),
      password: await bcrypt.hash(password, salt),
      terms_accepted:
        terms_accepted === "true" || terms_accepted === true ? "true" : "false",
    });

    return res.status(200).json({
      code: 200,
      status: "Success",
      message: "User Register successfully!",
      user,
    });
  } catch (error) {
    return next(error);
  }
};

// Login User
export const userLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    // A single failure shape for "no such account" and "wrong password", so
    // login cannot be used to enumerate registered addresses.
    const invalid = () =>
      res.status(400).json({
        code: 400,
        status: "Error",
        message: "Invalid credentials",
      });

    if (typeof email !== "string" || typeof password !== "string") {
      return invalid();
    }

    const user = await findByEmail(email, "+password");
    if (!user) return invalid();

    const verifyPassword = await bcrypt.compare(password, user.password);
    if (!verifyPassword) return invalid();

    const userObject = user.toObject();

    return res.status(200).json({
      code: 200,
      status: "Success",
      message: "Successfully logedIn",
      user: userObject,
    });
  } catch (error) {
    return next(error);
  }
};

// Update User Data
export const userUpdate = async (req, res, next) => {
  try {
    const saveData = req.body ?? {};

    const user = await findByEmail(saveData.email);
    if (!user) {
      return res.status(400).json({
        code: 400,
        status: "Error",
        message: "Email address not found!",
      });
    }

    // Released clients serialize their whole DTO, sending explicit nulls for
    // fields they are not setting, so null means "leave alone". Checking
    // undefined as well makes the empty-request branch reachable, which it
    // was not before.
    const allowedUpdates = {};
    const wantsSubscription =
      saveData.subscription_date !== null &&
      saveData.subscription_date !== undefined;

    // Once an account has a server-owned entitlement, subscription_date is
    // derived and client writes to it are ignored. The response still reports
    // success, so released clients are unaffected, but the unauthenticated
    // entitlement grant closes for that account. It closes for everyone when
    // v1 retires.
    const locked = wantsSubscription && (await legacyWritesLocked(user._id));

    if (wantsSubscription && !locked) {
      allowedUpdates.subscription_date = saveData.subscription_date;
    }
    if (saveData.terms_accepted !== null && saveData.terms_accepted !== undefined) {
      allowedUpdates.terms_accepted = String(
        saveData.terms_accepted === "true" || saveData.terms_accepted === true
      );
    }

    if (Object.keys(allowedUpdates).length === 0 && !locked) {
      return res.status(400).json({
        code: 400,
        status: "Error",
        message: "No valid fields to update.",
      });
    }

    // This endpoint is unauthenticated and cannot be closed without breaking
    // released clients, so entitlement writes are recorded for review. The
    // audit is best-effort and must never fail the request.
    if (wantsSubscription) {
      try {
        await EntitlementAudit.create({
          ignored: locked,
          email_norm: normalizeEmail(saveData.email),
          previous_subscription_date: user.subscription_date,
          next_subscription_date: String(saveData.subscription_date),
          ip: req.ip,
          user_agent: req.get("user-agent"),
        });
      } catch (auditError) {
        logger.error("entitlement audit write failed", {
          error: auditError.message,
        });
      }
    }

    if (Object.keys(allowedUpdates).length) {
      await User.updateOne({ _id: user._id }, { $set: allowedUpdates });
    }
    const updated = await User.findById(user._id).select(PUBLIC_FIELDS);

    return res.status(200).json({
      code: 200,
      status: "Success",
      message: "User date updated!",
      user: updated,
    });
  } catch (error) {
    return next(error);
  }
};

// Get a single user by email
export const getUser = async (req, res, next) => {
  try {
    const user = await findByEmail(req.params.email);

    if (!user) {
      return res.status(400).json({
        code: 400,
        status: "Error",
        message: "Email address not found!",
      });
    }

    return res.status(200).json({
      code: 200,
      status: "Success",
      message: "User fetched successfully!",
      user,
    });
  } catch (error) {
    return next(error);
  }
};
