import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { RefreshToken } from "../../src/models/refreshToken";
import { sha256 } from "../../src/util/crypto";

const app = createApp();
const PASSWORD = "a-sufficiently-long-password";

const register = async (email) =>
  (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

/**
 * The window between consuming a refresh token and creating its successor.
 *
 * A loser arriving in that window sees a revoked token. If it cannot tell
 * "just rotated" from "deliberately revoked" it revokes the whole family and
 * signs out the request that just won - the exact outcome the grace window
 * exists to prevent.
 */
describe("refresh rotation under a paused winner", () => {
  afterEach(() => jest.restoreAllMocks());

  it("does not revoke the family when a loser arrives between the two writes", async () => {
    // The window the reviewer identified: revoked_at is set by one update and
    // replaced_by by another. A loser landing between them sees a revoked
    // token with no successor, which is indistinguishable from a deliberate
    // revocation - so it nukes the family the winner just created.
    const tokens = await register("race-window-0@example.com");
    const user = await User.findOne({ email_norm: "race-window-0@example.com" });

    let reachedSecondWrite;
    const arrived = new Promise((resolve) => {
      reachedSecondWrite = resolve;
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });

    // Pauses the write that consumes the presented token and names its
    // successor. Rotation performs that as ONE findOneAndUpdate; this hook used
    // to watch updateOne for the same thing, which no call has done since the
    // two writes were merged - so it never engaged, the loser below never ran,
    // and this test quietly stopped exercising the window it is named after.
    const realClaim = RefreshToken.findOneAndUpdate.bind(RefreshToken);
    let paused = false;
    jest.spyOn(RefreshToken, "findOneAndUpdate").mockImplementation(async (filter, update, ...rest) => {
      const setsSuccessor = update && update.$set && "replaced_by" in update.$set;

      // Only the winner waits. The loser reaches the same line, and holding it
      // there too would deadlock the test rather than test anything.
      if (!setsSuccessor || paused) return realClaim(filter, update, ...rest);
      paused = true;

      // Paused AFTER the consume lands, which is the window a loser has to
      // arrive in for this to be a test of anything.
      const claimed = await realClaim(filter, update, ...rest);
      reachedSecondWrite();
      await held;
      return claimed;
    });

    const winner = request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token })
      .then((res) => res);

    // If the winner never performs a separate successor write, the rotation
    // is already atomic and there is no window to test.
    const raced = await Promise.race([
      arrived.then(() => "paused"),
      winner.then(() => "finished"),
    ]);

    let loser = null;
    if (raced === "paused") {
      loser = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: tokens.refresh_token });
    }
    // Released before asserting, so a failed expectation cannot leave the
    // winner parked and hang the suite.
    release();

    if (loser) {
      expect(loser.status).toBe(409);
      expect(loser.body.code).toBe("refresh_in_progress");
    }

    const winnerResult = await winner;
    expect(winnerResult.status).toBe(200);

    const usable = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: winnerResult.body.refresh_token });
    expect(usable.status).toBe(200);

    const orphanRevocations = await RefreshToken.countDocuments({
      user_id: user._id,
      revoked_at: { $exists: true },
      replaced_by: { $exists: false },
    });
    expect(orphanRevocations).toBe(0);
  });

  it("does not revoke the family when a loser arrives before the successor exists", async () => {
    const tokens = await register("race-window-1@example.com");
    const user = await User.findOne({ email_norm: "race-window-1@example.com" });

    let reachedCreate;
    const arrivedAtCreate = new Promise((resolve) => {
      reachedCreate = resolve;
    });
    let releaseCreate;
    const held = new Promise((resolve) => {
      releaseCreate = resolve;
    });

    const realCreate = RefreshToken.create.bind(RefreshToken);
    jest.spyOn(RefreshToken, "create").mockImplementation(async (...args) => {
      reachedCreate();
      await held;
      return realCreate(...args);
    });

    // Winner: consumes the token, then parks before writing its successor.
    // .then() is what actually dispatches a supertest request.
    const winner = request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token })
      .then((res) => res);

    await arrivedAtCreate;

    // Loser arrives in exactly that window.
    const loser = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    expect(loser.status).toBe(409);
    expect(loser.body.code).toBe("refresh_in_progress");

    releaseCreate();
    const winnerResult = await winner;
    expect(winnerResult.status).toBe(200);

    // The winning session must still work.
    const usable = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: winnerResult.body.refresh_token });
    expect(usable.status).toBe(200);

    const revokedFamily = await RefreshToken.countDocuments({
      user_id: user._id,
      revoked_at: { $exists: true },
      replaced_by: { $exists: false },
    });
    expect(revokedFamily).toBe(0);
  });

  it("leaves the presented token usable when the successor cannot be written", async () => {
    // A database failure between consumption and successor creation must not
    // burn the only token the client holds.
    const tokens = await register("race-window-2@example.com");

    jest
      .spyOn(RefreshToken, "create")
      .mockRejectedValueOnce(new Error("transient write failure"));

    const failed = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    expect(failed.status).toBeGreaterThanOrEqual(500);

    jest.restoreAllMocks();

    const retry = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    expect(retry.status).toBe(200);
    expect(retry.body.refresh_token).toEqual(expect.any(String));
  });

  it("records the successor and the revocation together", async () => {
    const tokens = await register("race-window-3@example.com");

    const before = await RefreshToken.findOne({ token_hash: sha256(tokens.refresh_token) });
    expect(before.revoked_at).toBeFalsy();
    expect(before.replaced_by).toBeFalsy();

    const rotated = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    const after = await RefreshToken.findOne({ token_hash: sha256(tokens.refresh_token) });
    // Both, or neither - never one without the other.
    expect(after.revoked_at).toBeTruthy();
    expect(after.replaced_by).toBe(sha256(rotated.body.refresh_token));
  });
});

describe("a revoked family cannot be resurrected", () => {
  const originalGrace = process.env.REFRESH_REUSE_GRACE_MS;

  afterEach(() => {
    process.env.REFRESH_REUSE_GRACE_MS = originalGrace || "10000";
    jest.restoreAllMocks();
  });

  it("does not leave a usable token behind when the successor lands after revocation", async () => {
    // A stalls past the grace window; B presents the old token, which is now
    // a genuine replay, so the family is revoked. A then finishes and inserts
    // its successor - which must not resurrect the session.
    process.env.REFRESH_REUSE_GRACE_MS = "40";

    const tokens = await register("resurrect-1@example.com");
    const user = await User.findOne({ email_norm: "resurrect-1@example.com" });

    let reachedCreate;
    const arrived = new Promise((resolve) => {
      reachedCreate = resolve;
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });

    const realCreate = RefreshToken.create.bind(RefreshToken);
    jest.spyOn(RefreshToken, "create").mockImplementation(async (...args) => {
      reachedCreate();
      await held;
      return realCreate(...args);
    });

    const winner = request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token })
      .then((res) => res);

    await arrived;
    // Let the grace window lapse so the next presentation is a real replay.
    await new Promise((r) => setTimeout(r, 80));

    const replay = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    release();
    const winnerResult = await winner;

    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("token_reused");

    // Whatever the winner ended up returning, no usable session may survive
    // the revocation.
    if (winnerResult.status === 200) {
      const resurrected = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: winnerResult.body.refresh_token });
      expect(resurrected.status).toBe(401);
    }

    const usable = await RefreshToken.countDocuments({
      user_id: user._id,
      revoked_at: { $exists: false },
    });
    expect(usable).toBe(0);
  });
});
