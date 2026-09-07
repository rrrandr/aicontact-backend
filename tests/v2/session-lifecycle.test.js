import request from "supertest";
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

/** Parks execution at a chosen model call so a race can be staged exactly. */
const pauseAt = (Model, method, when = () => true) => {
  let reached;
  const arrived = new Promise((resolve) => {
    reached = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  const real = Model[method].bind(Model);
  let armed = true;
  jest.spyOn(Model, method).mockImplementation(async (...args) => {
    if (armed && when(...args)) {
      armed = false;
      reached();
      await held;
    }
    return real(...args);
  });

  return { arrived, release: () => release() };
};

const seedReset = async (email, rawToken) => {
  await request(app).post("/api/v2/auth/password/forgot").send({ email });
  const user = await User.findOne({ email_norm: email });
  const record = await PasswordReset.findOne({
    user_id: user._id,
    used_at: { $exists: false },
  }).sort({ created_at: -1 });
  await PasswordReset.updateOne(
    { _id: record._id },
    { $set: { token_hash: sha256(rawToken) } }
  );
  return record;
};

/**
 * One invariant: a refresh-token family belongs to the credential generation
 * it was created under. Everything below is a way of leaving a session behind
 * that generation.
 */
describe("sessions are bound to the credential generation", () => {
  afterEach(() => jest.restoreAllMocks());

  it("kills a login that creates its family after a reset revoked everything", async () => {
    // The login verifies the old password, then stalls. The reset runs and
    // enumerates families - this one does not exist yet. The login then
    // creates it, landing a session behind the new credential generation.
    const email = "lifecycle-login-race@example.com";
    await register(email);
    await seedReset(email, "login-race-token");

    const gate = pauseAt(TokenFamily, "findOneAndUpdate");

    const login = request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: PASSWORD })
      .then((res) => res);

    await gate.arrived;

    const reset = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "login-race-token", password: "reset-during-login" });
    expect(reset.status).toBe(200);

    gate.release();
    const loggedIn = await login;

    if (loggedIn.status === 200) {
      const withAccess = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${loggedIn.body.access_token}`);
      expect(withAccess.status).toBe(401);

      const withRefresh = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: loggedIn.body.refresh_token });
      expect(withRefresh.status).toBe(401);
    }

    // And the old password is genuinely gone.
    const oldPassword = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: PASSWORD });
    expect(oldPassword.status).toBe(401);
  });

  it("records the credential generation on every family", async () => {
    const email = "lifecycle-generation@example.com";
    await register(email);
    const user = await User.findOne({ email_norm: email });

    const families = await TokenFamily.find({ user_id: user._id });
    expect(families.length).toBeGreaterThanOrEqual(1);
    for (const family of families) {
      expect(family.token_version).toBe(user.token_version ?? 0);
    }
  });

  it("refuses a family whose generation no longer matches the account", async () => {
    const email = "lifecycle-stale-family@example.com";
    const tokens = await register(email);
    const user = await User.findOne({ email_norm: email });

    // Simulate a family left behind by an earlier generation.
    await User.updateOne({ _id: user._id }, { $inc: { token_version: 1 } });

    const res = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    expect(res.status).toBe(401);
    expect(
      await TokenFamily.countDocuments({ user_id: user._id, revoked_at: { $exists: false } })
    ).toBe(0);
  });
});

describe("a stale login cannot resurrect the old password", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps the reset password when a rehashing login was already in flight", async () => {
    // Login reads the account, decides to upgrade the stored hash, and stalls.
    // A reset changes the password meanwhile. If the login then saves the
    // document it is holding, it writes the OLD password back.
    const bcrypt = require("bcryptjs");
    const email = "lifecycle-rehash@example.com";

    await User.create({
      email,
      email_norm: email,
      // Below the configured cost, so login takes the rehash path.
      password: await bcrypt.hash(PASSWORD, 4),
      status: "active",
      subject_id: "sub_rehash_race_fixture",
    });

    await seedReset(email, "rehash-race-token");

    const gate = pauseAt(bcrypt, "hash");

    const login = request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: PASSWORD })
      .then((res) => res);

    await gate.arrived;

    const reset = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "rehash-race-token", password: "password-after-reset" });
    expect(reset.status).toBe(200);

    gate.release();
    await login;

    const withOld = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: PASSWORD });
    expect(withOld.status).toBe(401);

    const withNew = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "password-after-reset" });
    expect(withNew.status).toBe(200);
  });
});

describe("refresh cannot rebase a session onto a newer generation", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not mint a post-reset access token for a pre-reset session", async () => {
    // Rotation validates the family against the generation it read. If the
    // access token is then signed from a LATER read of the account, a session
    // whose family was just revoked walks away with a token carrying the new
    // generation - and authenticates with it.
    const tokenService = require("../../src/v2/services/tokenService");
    const email = "lifecycle-refresh-rebase@example.com";
    const tokens = await register(email);
    await seedReset(email, "refresh-rebase-token");

    // Park after rotation has finished validating, before anything the
    // controller does next.
    let reached;
    const arrived = new Promise((resolve) => {
      reached = resolve;
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });

    const realRotate = tokenService.rotateRefreshToken;
    jest
      .spyOn(tokenService, "rotateRefreshToken")
      .mockImplementation(async (...args) => {
        const result = await realRotate(...args);
        reached();
        await held;
        return result;
      });

    const refreshing = request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token })
      .then((res) => res);

    await arrived;

    const reset = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "refresh-rebase-token", password: "password-after-refresh-race" });
    expect(reset.status).toBe(200);

    release();
    const refreshed = await refreshing;

    if (refreshed.status === 200) {
      const withAccess = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${refreshed.body.access_token}`);
      expect(withAccess.status).toBe(401);

      const withRefresh = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: refreshed.body.refresh_token });
      expect(withRefresh.status).toBe(401);
    }
  });

  it("signs the access token with the generation rotation validated", async () => {
    const jwt = require("jsonwebtoken");
    const email = "lifecycle-refresh-generation@example.com";
    const tokens = await register(email);
    const user = await User.findOne({ email_norm: email });

    const res = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    expect(res.status).toBe(200);
    const claims = jwt.decode(res.body.access_token);
    expect(claims.tv).toBe(user.token_version ?? 0);
  });

  it("returns no credential at all from account deletion", async () => {
    // Deletion is the other boundary that ends a generation. It mints
    // nothing, so there is no equivalent rebase to make.
    const email = "lifecycle-delete-nocred@example.com";
    const tokens = await register(email);

    const res = await request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.refresh_token).toBeUndefined();

    const after = await request(app)
      .get("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`);
    expect(after.status).toBe(401);
  });
});

describe("logout ends the family, not just the row", () => {
  afterEach(() => jest.restoreAllMocks());

  it("kills a successor created after logout used the original token", async () => {
    // Rotation has already consumed the presented row, so revoking that row
    // alone does nothing and the successor stays usable.
    const email = "lifecycle-logout@example.com";
    const tokens = await register(email);
    const user = await User.findOne({ email_norm: email });

    const gate = pauseAt(RefreshToken, "create");

    const rotation = request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token })
      .then((res) => res);

    await gate.arrived;

    const loggedOut = await request(app)
      .post("/api/v2/auth/logout")
      .send({ refresh_token: tokens.refresh_token });
    expect(loggedOut.status).toBe(200);

    gate.release();
    const rotated = await rotation;

    if (rotated.status === 200) {
      const survivor = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: rotated.body.refresh_token });
      expect(survivor.status).toBe(401);
    }

    expect(
      await RefreshToken.countDocuments({ user_id: user._id, revoked_at: { $exists: false } })
    ).toBe(0);
  });

  it("ends the family for an ordinary logout too", async () => {
    const email = "lifecycle-logout-simple@example.com";
    const tokens = await register(email);
    const user = await User.findOne({ email_norm: email });

    await request(app)
      .post("/api/v2/auth/logout")
      .send({ refresh_token: tokens.refresh_token });

    expect(
      await TokenFamily.countDocuments({ user_id: user._id, revoked_at: { $exists: false } })
    ).toBe(0);
  });

  it("still says nothing about a token it has never seen", async () => {
    const res = await request(app)
      .post("/api/v2/auth/logout")
      .send({ refresh_token: "a-token-that-never-existed" });
    expect(res.status).toBe(200);
  });

  it("does not touch another account's sessions", async () => {
    const mine = await register("lifecycle-logout-mine@example.com");
    const theirs = await register("lifecycle-logout-theirs@example.com");

    await request(app)
      .post("/api/v2/auth/logout")
      .send({ refresh_token: mine.refresh_token });

    const stillWorks = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: theirs.refresh_token });
    expect(stillWorks.status).toBe(200);
  });
});

describe("a successful reset ends every outstanding reset link", () => {
  it("invalidates an older link when the newest one is used", async () => {
    const email = "lifecycle-reset-newest@example.com";
    await register(email);

    await seedReset(email, "older-link");
    await new Promise((r) => setTimeout(r, 10));
    await seedReset(email, "newer-link");

    const newer = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "newer-link", password: "set-by-newer-link" });
    expect(newer.status).toBe(200);

    const older = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "older-link", password: "set-by-older-link" });
    expect(older.status).toBe(400);

    const asOlder = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "set-by-older-link" });
    expect(asOlder.status).toBe(401);

    const asNewer = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "set-by-newer-link" });
    expect(asNewer.status).toBe(200);
  });

  it("invalidates a newer link when an older one is used first", async () => {
    const email = "lifecycle-reset-oldest@example.com";
    await register(email);

    await seedReset(email, "first-link");
    await new Promise((r) => setTimeout(r, 10));
    await seedReset(email, "second-link");

    const first = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "first-link", password: "set-by-first-link" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "second-link", password: "set-by-second-link" });
    expect(second.status).toBe(400);

    const asSecond = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "set-by-second-link" });
    expect(asSecond.status).toBe(401);

    const asFirst = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "set-by-first-link" });
    expect(asFirst.status).toBe(200);
  });

  it("invalidates a sibling link even when the timestamps are identical", async () => {
    // Ordering security events by millisecond timestamps has an equality
    // edge. This drives the last line of defence directly: the link's
    // timestamp condition is made to pass, so only the credential generation
    // it was issued under can refuse it.
    const email = "lifecycle-reset-sametime@example.com";
    await register(email);

    await seedReset(email, "twin-a");
    const twinB = await seedReset(email, "twin-b");

    const first = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "twin-a", password: "set-by-twin-a-passphrase" });
    expect(first.status).toBe(200);

    const user = await User.findOne({ email_norm: email });

    // Revive the sibling and align its timestamp with the password change, so
    // the time-based guard cannot be what rejects it.
    await PasswordReset.updateOne(
      { _id: twinB._id },
      {
        $set: { created_at: user.password_updated_at },
        $unset: { used_at: 1, processing_started_at: 1, lease_token: 1 },
      }
    );

    const second = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "twin-b", password: "set-by-twin-b" });
    expect(second.status).toBe(400);

    const asB = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "set-by-twin-b" });
    expect(asB.status).toBe(401);

    const asA = await request(app)
      .post("/api/v2/auth/login")
      .send({ email, password: "set-by-twin-a-passphrase" });
    expect(asA.status).toBe(200);
  });

  it("leaves no outstanding reset records behind", async () => {
    const email = "lifecycle-reset-cleanup@example.com";
    await register(email);

    await seedReset(email, "cleanup-a");
    await seedReset(email, "cleanup-b");

    await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "cleanup-b", password: "cleanup-new-password" });

    const user = await User.findOne({ email_norm: email });
    expect(
      await PasswordReset.countDocuments({ user_id: user._id, used_at: { $exists: false } })
    ).toBe(0);
  });
});
