/**
 * Which tier an account is on, and what must never change it.
 *
 * The rule under test is precedence: active paid access is resolved BEFORE the
 * free marker is consulted, so a stale free marker can never outrank a real
 * subscription. Free is not an entitlement row at all - it lives on the user -
 * because a row for it would be an invented subscription with no expiry,
 * competing in a collection sorted by expiry against records that are real.
 */
import mongoose from "mongoose";
import { Entitlement } from "../../src/models/entitlement";
import { User } from "../../src/models/user";
import { resolveEntitlement, upsertEntitlement } from "../../src/v2/services/entitlementService";

const hour = 60 * 60 * 1000;

const makeUser = async (fields = {}) =>
  User.create({
    email: `tier-${new mongoose.Types.ObjectId()}@example.com`,
    password: "hashed-not-a-real-password",
    subject_id: String(new mongoose.Types.ObjectId()),
    ...fields,
  });

const givePaid = async (user, fields = {}) =>
  Entitlement.create({
    user_id: user._id,
    subject_id: user.subject_id,
    platform: "paypal",
    status: "active",
    expires_at: new Date(Date.now() + 30 * 24 * hour),
    auto_renew: true,
    ...fields,
  });

beforeEach(async () => {
  await Entitlement.deleteMany({});
  await User.deleteMany({});
});

describe("tier resolution", () => {
  it("reports paid for an active entitlement", async () => {
    const user = await makeUser();
    await givePaid(user);

    const resolved = await resolveEntitlement(user);

    expect(resolved.active).toBe(true);
    expect(resolved.tier).toBe("paid");
  });

  it("reads an active legacy row with no tier as paid", async () => {
    const user = await makeUser();
    const row = await givePaid(user);

    // The legacy shape: written before the field existed.
    await Entitlement.collection.updateOne({ _id: row._id }, { $unset: { tier: 1 } });

    const resolved = await resolveEntitlement(user);

    expect(resolved.tier).toBe("paid");
  });

  it("reports free for an account with the marker and no active entitlement", async () => {
    const user = await makeUser({ free_plan_since: new Date() });

    const resolved = await resolveEntitlement(user);

    expect(resolved.active).toBe(false);
    expect(resolved.tier).toBe("free");
  });

  /**
   * The precedence that makes free-without-expiry safe to store.
   */
  it("does not let a stale free marker outrank a real paid subscription", async () => {
    const user = await makeUser({ free_plan_since: new Date(Date.now() - 90 * 24 * hour) });
    await givePaid(user);

    const resolved = await resolveEntitlement(user);

    expect(resolved.tier).toBe("paid");
  });

  it("reports no tier at all when nothing is known", async () => {
    const user = await makeUser();

    const resolved = await resolveEntitlement(user);

    // Not "free". Nobody has told us anything, and the client reads null as
    // unverified and grants nothing.
    expect(resolved.tier).toBeNull();
  });

  it("does not report an expired entitlement as paid", async () => {
    const user = await makeUser();
    await givePaid(user, {
      status: "expired",
      expires_at: new Date(Date.now() - hour),
      auto_renew: false,
    });

    const resolved = await resolveEntitlement(user);

    expect(resolved.active).toBe(false);
    expect(resolved.tier).toBeNull();
  });
});

describe("pending changes", () => {
  it("reports a pending change without resolving it as the current tier", async () => {
    const user = await makeUser();
    await givePaid(user, {
      pending_change: {
        tier: "free",
        effective_at: new Date(Date.now() - 30 * 24 * hour), // long past
        source: "user",
      },
    });

    const resolved = await resolveEntitlement(user);

    expect(resolved.tier).toBe("paid");
    expect(resolved.pending_change.tier).toBe("free");
  });

  /**
   * An unrelated provider update - a renewal, say - must not quietly drop a
   * scheduled change. upsertEntitlement sets an explicit field list and never
   * names these, which is what preserves them; this is here so that stays true.
   */
  it("preserves tier and a pending change across an unrelated provider update", async () => {
    const user = await makeUser();
    await givePaid(user, {
      pending_change: { tier: "free", effective_at: new Date(Date.now() + 7 * 24 * hour) },
    });

    await upsertEntitlement({
      user,
      platform: "paypal",
      productId: "monthly",
      status: "active",
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 24 * hour),
      autoRenew: true,
      environment: "Production",
      sourceRef: "renewal-event",
    });

    const row = await Entitlement.findOne({ user_id: user._id, platform: "paypal" });

    expect(row.tier).toBe("paid");
    expect(row.pending_change?.tier).toBe("free");
  });
});
