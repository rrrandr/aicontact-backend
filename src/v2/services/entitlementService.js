import { Entitlement, ACTIVE_STATUSES } from "../../models/entitlement";
import { AuditLog } from "../../models/auditLog";
import { User } from "../../models/user";
import { config } from "../../config/env";
import { logger } from "../../util/logger";
import { environmentAllowed } from "./appleService";

/**
 * The single writer for entitlement state.
 *
 * Nothing here takes its values from a request body. Every caller is either
 * provider verification or a provider webhook, and the shape they pass has
 * already been checked against the provider's own record.
 */

// A cancellation must never shorten access the subscriber has already paid
// for, but a refund or a revocation is exactly a statement that they have not.
const IGNORES_PAID_PERIOD = new Set(["revoked", "refunded"]);

/**
 * Applies the preserved access-end date as a floor.
 *
 * The cancellation webhook arrives after PayPal has already cleared
 * next_billing_time, so the shape derived from it says "expired, no expiry".
 * Written as-is that would revoke a period the subscriber paid for - and the
 * event is replayed on every retry, so it would do it repeatedly. The floor is
 * whatever we recorded at cancellation, or, when the cancellation happened in
 * PayPal's own interface and we are learning of it now, the expiry we last
 * held. Only a refund or revocation is allowed past it.
 */
const applyPreservedAccess = (existing, incoming, preserveAccessUntil) => {
  const floor = existing?.access_ends_at || preserveAccessUntil || null;

  if (!floor || IGNORES_PAID_PERIOD.has(incoming.status)) return incoming;
  if (floor.getTime() <= Date.now()) {
    // Already elapsed: keep the record so the management view can still show
    // what happened, but do not extend anything.
    return { ...incoming, accessEndsAt: floor };
  }

  return {
    ...incoming,
    accessEndsAt: floor,
    autoRenew: false,
    status: incoming.status === "expired" ? "active" : incoming.status,
    expiresAt:
      !incoming.expiresAt || incoming.expiresAt.getTime() < floor.getTime()
        ? floor
        : incoming.expiresAt,
  };
};

export const upsertEntitlement = async ({
  user,
  platform,
  productId,
  status,
  startsAt,
  expiresAt,
  autoRenew,
  environment,
  sourceRef,
  // Only supplied by the PayPal webhook, which is where we may first learn
  // that a subscription was cancelled outside the app.
  preserveAccessUntil = null,
}) => {
  const existing = await Entitlement.findOne({ user_id: user._id, platform });

  const resolved = applyPreservedAccess(
    existing,
    { status, expiresAt, autoRenew: Boolean(autoRenew), accessEndsAt: null },
    preserveAccessUntil
  );

  // A subscription that is active and will bill again is not cancelled, so the
  // cancellation record is cleared rather than left to contradict it.
  const billingAgain = resolved.status === "active" && resolved.autoRenew;

  const entitlement = await Entitlement.findOneAndUpdate(
    { user_id: user._id, platform },
    {
      $set: {
        subject_id: user.subject_id,
        product_id: productId,
        status: resolved.status,
        starts_at: startsAt,
        expires_at: resolved.expiresAt,
        auto_renew: resolved.autoRenew,
        environment: environment || "Production",
        source_ref: sourceRef,
        updated_at: new Date(),
        ...(billingAgain || !resolved.accessEndsAt
          ? {}
          : { access_ends_at: resolved.accessEndsAt }),
      },
      ...(billingAgain
        ? { $unset: { access_ends_at: 1, cancelled_at: 1, cancellation_source: 1 } }
        : {}),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await AuditLog.create({
    action: "entitlement.upsert",
    user_id: user._id,
    subject_id: user.subject_id,
    detail: { platform, status, product_id: productId, expires_at: expiresAt },
  });

  // Released v1 clients read users.subscription_date and compute expiry
  // themselves. Keeping it in step means a user who upgrades to v2 on one
  // device is not locked out on another still running v1.
  await syncLegacyField(user, entitlement);

  return entitlement;
};

const LEGACY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Derives the value released v1 clients read.
 *
 * They compute `30 - (now - subscription_date).Days` and grant access while
 * that is positive (InAppPurchaseScreenHandler.cs:165-177), so the field has
 * to describe the CURRENT billing period. Writing the subscription's original
 * start date would read as expired for anyone more than a month old - which
 * is every renewing subscriber.
 *
 * Working backwards from the authoritative expiry makes v1's arithmetic land
 * on the real number of days remaining. The value is capped at the present so
 * a longer plan cannot produce a future date.
 */
const syncLegacyField = async (user, entitlement) => {
  let legacyValue = "";

  if (isActive(entitlement)) {
    const expiresAt = entitlement.expires_at
      ? entitlement.expires_at.getTime()
      : Date.now() + LEGACY_WINDOW_DAYS * DAY_MS;

    const derived = Math.min(expiresAt - LEGACY_WINDOW_DAYS * DAY_MS, Date.now());
    legacyValue = formatLegacyDate(new Date(derived));
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { subscription_date: legacyValue } }
  );
};

// v1 stored whatever DateTime.Now.ToString() produced on the client, which
// DateTime.Parse then read back. An invariant, unambiguous format is the
// safest thing to hand that parser.
const formatLegacyDate = (date) => {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
};

/**
 * Records a confirmed cancellation against the entitlement.
 *
 * Called only after the provider has confirmed the subscription is no longer
 * billing. Access is left in place until the date already paid for, so the
 * status stays active and simply lapses on its own; writing "expired" here
 * would take away a period the subscriber has bought.
 */
export const recordCancellation = async ({ user, platform, accessEndsAt, source }) => {
  const now = new Date();
  const stillCovered = Boolean(accessEndsAt && accessEndsAt.getTime() > now.getTime());

  const entitlement = await Entitlement.findOneAndUpdate(
    { user_id: user._id, platform },
    {
      $set: {
        subject_id: user.subject_id,
        access_ends_at: accessEndsAt,
        cancelled_at: now,
        cancellation_source: source,
        auto_renew: false,
        status: stillCovered ? "active" : "expired",
        expires_at: accessEndsAt,
        updated_at: now,
      },
    },
    { new: true }
  );

  // No entitlement row means the subscription never activated - there is
  // nothing to preserve and nothing to revoke.
  if (!entitlement) return null;

  await AuditLog.create({
    action: "entitlement.cancelled",
    user_id: user._id,
    subject_id: user.subject_id,
    detail: { platform, source, access_ends_at: accessEndsAt },
  });

  await syncLegacyField(user, entitlement);

  return entitlement;
};

export const isActive = (entitlement) => {
  if (!entitlement) return false;
  if (!ACTIVE_STATUSES.includes(entitlement.status)) return false;

  // Environment is re-checked on every read, not only at creation. A row
  // written while sandbox was permitted must stop granting access the moment
  // it is not - otherwise the policy is only as good as the day it changed.
  if (entitlement.platform === "apple" && !environmentAllowed(entitlement.environment)) {
    return false;
  }

  if (!entitlement.expires_at) return true;
  return entitlement.expires_at.getTime() > Date.now();
};

/**
 * Current entitlement across all platforms. Expiry is evaluated here, on the
 * server, rather than by the client - which is where the released builds got
 * it wrong in both directions.
 */
export const resolveEntitlement = async (user) => {
  const rows = await Entitlement.find({ user_id: user._id });
  const active = rows.filter(isActive);

  const best = active.sort((a, b) => {
    const aExp = a.expires_at ? a.expires_at.getTime() : Infinity;
    const bExp = b.expires_at ? b.expires_at.getTime() : Infinity;
    return bExp - aExp;
  })[0];

  return {
    active: Boolean(best),
    platform: best ? best.platform : null,
    product_id: best ? best.product_id : null,
    status: best ? best.status : "none",
    expires_at: best && best.expires_at ? best.expires_at.toISOString() : null,
    auto_renew: best ? best.auto_renew : false,
    environment: best ? best.environment : null,
    // Present so clients can render a countdown without computing expiry.
    days_remaining: best && best.expires_at
      ? Math.max(0, Math.ceil((best.expires_at.getTime() - Date.now()) / 86400000))
      : null,
  };
};

/**
 * Whether v1's PATCH /update should still be allowed to write
 * subscription_date for this user.
 *
 * Once an account has a server-owned entitlement, the legacy field is derived
 * and client writes to it are ignored - the response still reports success, so
 * released clients are unaffected, but the bypass closes for that account. It
 * closes for everyone when v1 retires.
 */
export const legacyWritesLocked = async (userId) => {
  if (!config.v1EntitlementReadonly) return false;
  const count = await Entitlement.countDocuments({ user_id: userId });
  if (count > 0) {
    logger.info("legacy entitlement write ignored", { user_id: String(userId) });
    return true;
  }
  return false;
};
