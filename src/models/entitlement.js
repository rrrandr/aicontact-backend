import mongoose from "mongoose";

/**
 * The authoritative record of what a user is entitled to.
 *
 * Server-owned: no request handler writes this from client input. Rows are
 * created and updated only by provider verification and provider webhooks.
 */
const entitlementSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "user", index: true },
    subject_id: { type: String, index: true },

    platform: { type: String, enum: ["apple", "paypal"], required: true },
    product_id: String,

    status: {
      type: String,
      enum: ["active", "grace", "expired", "revoked", "refunded"],
      required: true,
      index: true,
    },

    starts_at: Date,
    expires_at: { type: Date, index: true },
    auto_renew: { type: Boolean, default: false },
    environment: { type: String, enum: ["Production", "Sandbox"], default: "Production" },

    // Which provider record produced this row, for tracing back.
    source_ref: String,
    updated_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } }
);

// One row per user per platform. Renewals update in place rather than
// accumulating history, which lives in the provider-specific collections.
//
// The constraint is partial on purpose. Account deletion detaches retained
// financial records by removing user_id, and a plain unique index treats every
// such row as { user_id: null }: the second person to delete an account with
// the same platform would collide, their deletion would fail, and deletion has
// to work. Scoping the index to rows that still have a user says what is
// actually meant - one entitlement per live account per platform.
entitlementSchema.index(
  { user_id: 1, platform: 1 },
  { unique: true, partialFilterExpression: { user_id: { $exists: true } } }
);

export const Entitlement = mongoose.model("entitlement", entitlementSchema);

// Grace covers a renewal that Apple is retrying: the subscription has not
// lapsed from the user's point of view and access should continue.
export const ACTIVE_STATUSES = ["active", "grace"];
