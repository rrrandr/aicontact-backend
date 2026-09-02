import { Entitlement, ACTIVE_STATUSES } from "../../models/entitlement";
import { AuditLog } from "../../models/auditLog";
import { User } from "../../models/user";
import { config } from "../../config/env";
import { logger } from "../../util/logger";

/**
 * The single writer for entitlement state.
 *
 * Nothing here takes its values from a request body. Every caller is either
 * provider verification or a provider webhook, and the shape they pass has
 * already been checked against the provider's own record.
 */

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
}) => {
  const entitlement = await Entitlement.findOneAndUpdate(
    { user_id: user._id, platform },
    {
      $set: {
        subject_id: user.subject_id,
        product_id: productId,
        status,
        starts_at: startsAt,
        expires_at: expiresAt,
        auto_renew: Boolean(autoRenew),
        environment: environment || "Production",
        source_ref: sourceRef,
        updated_at: new Date(),
      },
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

const syncLegacyField = async (user, entitlement) => {
  const legacyValue = isActive(entitlement)
    ? formatLegacyDate(entitlement.starts_at || new Date())
    : "";

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

export const isActive = (entitlement) => {
  if (!entitlement) return false;
  if (!ACTIVE_STATUSES.includes(entitlement.status)) return false;
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
