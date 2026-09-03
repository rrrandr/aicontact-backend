import { PasswordReset } from "../../src/models/passwordReset";
import {
  claimWithLease,
  settleLease,
  releaseLease,
} from "../../src/v2/services/leaseService";

/**
 * A lease that records only a timestamp cannot tell its holders apart.
 *
 * Worker A stalls, its lease goes stale, worker B takes over - and A can still
 * settle or release, marking B's work done or clearing B's active lease. The
 * lease has to carry an identity that every subsequent write proves.
 */
describe("lease fencing", () => {
  const makeRecord = (tokenHash) =>
    PasswordReset.create({
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });

  it("hands the lease to B once A's has gone stale", async () => {
    await makeRecord("fence-handover");

    const a = await claimWithLease(PasswordReset, { token_hash: "fence-handover" }, 50);
    expect(a).toBeTruthy();

    // A is still holding it, so B cannot take it yet.
    const tooEarly = await claimWithLease(PasswordReset, { token_hash: "fence-handover" }, 50);
    expect(tooEarly).toBeNull();

    await new Promise((r) => setTimeout(r, 70));

    const b = await claimWithLease(PasswordReset, { token_hash: "fence-handover" }, 50);
    expect(b).toBeTruthy();
    expect(b.lease_token).toEqual(expect.any(String));
    expect(b.lease_token).not.toBe(a.lease_token);
  });

  it("does not let a stale worker settle the work its successor is doing", async () => {
    await makeRecord("fence-settle");

    const a = await claimWithLease(PasswordReset, { token_hash: "fence-settle" }, 50);
    await new Promise((r) => setTimeout(r, 70));
    const b = await claimWithLease(PasswordReset, { token_hash: "fence-settle" }, 50);

    // A wakes up and tries to declare the work finished.
    const settled = await settleLease(PasswordReset, a._id, "used_at", a.lease_token);
    expect(settled).toBe(false);

    const after = await PasswordReset.findById(a._id);
    expect(after.used_at).toBeFalsy();
    expect(after.lease_token).toBe(b.lease_token);
  });

  it("does not let a stale worker release its successor's lease", async () => {
    await makeRecord("fence-release");

    const a = await claimWithLease(PasswordReset, { token_hash: "fence-release" }, 50);
    await new Promise((r) => setTimeout(r, 70));
    const b = await claimWithLease(PasswordReset, { token_hash: "fence-release" }, 50);

    const released = await releaseLease(PasswordReset, a._id, a.lease_token);
    expect(released).toBe(false);

    // B still holds an active lease, so a third worker cannot barge in.
    const c = await claimWithLease(PasswordReset, { token_hash: "fence-release" }, 50);
    expect(c).toBeNull();

    const after = await PasswordReset.findById(a._id);
    expect(after.lease_token).toBe(b.lease_token);
  });

  it("lets the current holder settle and release", async () => {
    await makeRecord("fence-owner");

    const a = await claimWithLease(PasswordReset, { token_hash: "fence-owner" }, 5000);
    expect(await releaseLease(PasswordReset, a._id, a.lease_token)).toBe(true);

    const b = await claimWithLease(PasswordReset, { token_hash: "fence-owner" }, 5000);
    expect(await settleLease(PasswordReset, b._id, "used_at", b.lease_token)).toBe(true);

    const after = await PasswordReset.findById(b._id);
    expect(after.used_at).toBeTruthy();
    expect(after.lease_token).toBeFalsy();
  });
});
