import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { RefreshToken } from "../../src/models/refreshToken";
import { TokenFamily } from "../../src/models/tokenFamily";
import { PasswordReset } from "../../src/models/passwordReset";
import { sha256 } from "../../src/util/crypto";

const app = createApp();
const PASSWORD = "a-sufficiently-long-password";

const register = async (email) =>
  (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

/** Pauses the successor insert so a rotation can be caught mid-flight. */
const pauseSuccessorCreation = () => {
  let reached;
  const arrived = new Promise((resolve) => {
    reached = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  const real = RefreshToken.create.bind(RefreshToken);
  jest.spyOn(RefreshToken, "create").mockImplementation(async (...args) => {
    reached();
    await held;
    return real(...args);
  });

  return { arrived, release: () => release() };
};

/**
 * revokeAllForUser is what password reset and account deletion rely on to end
 * every session. Revoking only the token rows that exist at that moment
 * leaves an in-flight rotation free to insert its successor afterwards, into
 * a family nobody ever marked dead.
 */
describe("revoke-all ends families, not just rows", () => {
  afterEach(() => jest.restoreAllMocks());

  it("makes a successor unusable when password reset runs mid-rotation", async () => {
    const email = "revokeall-reset@example.com";
    const tokens = await register(email);
    const user = await User.findOne({ email_norm: email });

    await request(app).post("/api/v2/auth/password/forgot").send({ email });
    await PasswordReset.updateOne(
      { user_id: user._id },
      { $set: { token_hash: sha256("revokeall-reset-token") } }
    );

    const gate = pauseSuccessorCreation();

    const rotation = request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token })
      .then((res) => res);

    await gate.arrived;

    // The whole account is reset while the rotation is parked.
    const reset = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "revokeall-reset-token", password: "a-brand-new-password" });
    expect(reset.status).toBe(200);

    gate.release();
    const rotated = await rotation;

    if (rotated.status === 200) {
      const survivor = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: rotated.body.refresh_token });
      expect(survivor.status).toBe(401);
    }

    const usable = await RefreshToken.countDocuments({
      user_id: user._id,
      revoked_at: { $exists: false },
    });
    expect(usable).toBe(0);

    const liveFamilies = await TokenFamily.countDocuments({
      user_id: user._id,
      revoked_at: { $exists: false },
    });
    expect(liveFamilies).toBe(0);
  });

  it("makes a successor unusable when account deletion runs mid-rotation", async () => {
    const email = "revokeall-delete@example.com";
    const tokens = await register(email);
    const user = await User.findOne({ email_norm: email });

    const gate = pauseSuccessorCreation();

    const rotation = request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token })
      .then((res) => res);

    await gate.arrived;

    const deleted = await request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ password: PASSWORD });
    expect(deleted.status).toBe(200);

    gate.release();
    const rotated = await rotation;

    if (rotated.status === 200) {
      const survivor = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: rotated.body.refresh_token });
      expect(survivor.status).toBe(401);
    }

    const usable = await RefreshToken.countDocuments({
      user_id: user._id,
      revoked_at: { $exists: false },
    });
    expect(usable).toBe(0);
  });

  it("marks every family for the account, including pre-existing ones", async () => {
    const email = "revokeall-families@example.com";
    await register(email);
    // A second and third session, each its own family.
    await request(app).post("/api/v2/auth/login").send({ email, password: PASSWORD });
    await request(app).post("/api/v2/auth/login").send({ email, password: PASSWORD });

    const user = await User.findOne({ email_norm: email });
    const before = await TokenFamily.countDocuments({ user_id: user._id });
    expect(before).toBeGreaterThanOrEqual(3);

    const { revokeAllForUser } = require("../../src/v2/services/tokenService");
    await revokeAllForUser(user._id);

    expect(
      await TokenFamily.countDocuments({ user_id: user._id, revoked_at: { $exists: false } })
    ).toBe(0);
  });
});

/**
 * The reset lease coordinates workflow. It cannot be the authority protecting
 * the User document, which is a different record entirely.
 */
describe("only one worker may change a password", () => {
  afterEach(() => jest.restoreAllMocks());

  it("stops a stale worker from setting a password after its successor did", async () => {
    const email = "stale-reset@example.com";
    await register(email);
    await request(app).post("/api/v2/auth/password/forgot").send({ email });

    const user = await User.findOne({ email_norm: email });
    await PasswordReset.updateOne(
      { user_id: user._id },
      { $set: { token_hash: sha256("stale-worker-token") } }
    );

    // Park the first worker after it has claimed the lease and begun hashing,
    // but before it touches the User document.
    let reached;
    const arrived = new Promise((resolve) => {
      reached = resolve;
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });

    const realHash = bcrypt.hash.bind(bcrypt);
    let first = true;
    jest.spyOn(bcrypt, "hash").mockImplementation(async (...args) => {
      if (first) {
        first = false;
        reached();
        await held;
      }
      return realHash(...args);
    });

    const workerA = request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "stale-worker-token", password: "password-from-worker-a" })
      .then((res) => res);

    await arrived;

    // A's lease goes stale and B takes it over.
    await PasswordReset.updateOne(
      { user_id: user._id },
      { $set: { processing_started_at: new Date(Date.now() - 10 * 60 * 1000) } }
    );

    const workerB = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "stale-worker-token", password: "password-from-worker-b" });

    release();
    const resultA = await workerA;

    // Exactly one of them may report success.
    const successes = [resultA.status, workerB.status].filter((s) => s === 200);
    expect(successes).toHaveLength(1);

    // And exactly one password may work.
    const asA = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "password-from-worker-a" });
    const asB = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "password-from-worker-b" });

    expect([asA.status, asB.status].filter((s) => s === 200)).toHaveLength(1);
  });
});
