import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { RefreshToken } from "../../src/models/refreshToken";
import { PasswordReset } from "../../src/models/passwordReset";
import { sha256 } from "../../src/util/crypto";

const app = createApp();
const PASSWORD = "a-sufficiently-long-password";

const register = (email, body = {}) =>
  request(app)
    .post("/api/v2/auth/register")
    .send({ email, password: PASSWORD, ...body });

describe("registration", () => {
  it("returns a token pair and a user without a password", async () => {
    const res = await register("v2new@example.com");

    expect(res.status).toBe(201);
    expect(res.body.access_token).toEqual(expect.any(String));
    expect(res.body.refresh_token).toEqual(expect.any(String));
    expect(res.body.user).not.toHaveProperty("password");
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
  });

  it("reports no entitlement for a new account", async () => {
    const res = await register("v2fresh@example.com");
    expect(res.body.user.entitlement.active).toBe(false);
    expect(res.body.user.entitlement.status).toBe("none");
  });

  it("assigns a pseudonymous subject id", async () => {
    await register("v2subject@example.com");
    const user = await User.findOne({ email_norm: "v2subject@example.com" });
    expect(user.subject_id).toMatch(/^sub_[0-9a-f]{32}$/);
  });

  it("refuses a duplicate address regardless of casing", async () => {
    await register("v2dupe@example.com");
    const res = await register("V2DUPE@Example.com");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("email_in_use");
  });

  it("refuses a short password", async () => {
    const res = await request(app)
      .post("/api/v2/auth/register")
      .send({ email: "v2short@example.com", password: "short" });
    expect(res.status).toBe(400);
  });

  it("ignores entitlement fields in the request body", async () => {
    const res = await register("v2massassign@example.com", {
      subscription_date: "01/01/2099 00:00:00",
      entitlement: { active: true },
    });

    expect(res.status).toBe(201);
    expect(res.body.user.entitlement.active).toBe(false);

    const user = await User.findOne({ email_norm: "v2massassign@example.com" });
    expect(user.subscription_date).toBe("");
  });
});

describe("login", () => {
  beforeAll(async () => {
    await register("v2login@example.com");
  });

  it("succeeds and issues tokens", async () => {
    const res = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "v2login@example.com", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toEqual(expect.any(String));
  });

  it("answers identically for an unknown account and a wrong password", async () => {
    const unknown = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "v2ghost@example.com", password: PASSWORD });
    const wrong = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "v2login@example.com", password: "the-wrong-password" });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("rejects a non-string password without querying", async () => {
    const res = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "v2login@example.com", password: { $ne: null } });
    expect(res.status).toBe(401);
  });

  it("upgrades a legacy bcrypt cost transparently", async () => {
    // Accounts created under v1 carry cost-10 hashes. There is no reason to
    // force a reset when the plaintext is in hand at sign-in.
    const legacyHash = await bcrypt.hash(PASSWORD, 4);
    await User.create({
      email: "v2legacy@example.com",
      email_norm: "v2legacy@example.com",
      password: legacyHash,
      status: "active",
    });

    const res = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "v2legacy@example.com", password: PASSWORD });

    expect(res.status).toBe(200);

    const user = await User.findOne({ email_norm: "v2legacy@example.com" });
    expect(user.password).not.toBe(legacyHash);
    expect(Number(user.password.split("$")[2])).toBeGreaterThan(4);
    // And a v1 account gains a subject id on first v2 sign-in.
    expect(user.subject_id).toMatch(/^sub_/);
  });
});

describe("refresh token rotation", () => {
  let tokens;

  beforeEach(async () => {
    const res = await register(`v2rotate${Date.now()}@example.com`);
    tokens = res.body;
  });

  it("issues a new pair and invalidates the old refresh token", async () => {
    const first = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    // Immediately after a rotation this reads as a concurrent duplicate; the
    // aged case below is what triggers reuse detection.
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("refresh_in_progress");
  });

  it("treats an immediate second presentation as a concurrent duplicate", async () => {
    // A client with two screens open refreshes twice at once. Only one token
    // is issued, but the session must survive.
    const rotated = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    const duplicate = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("refresh_in_progress");

    const stillWorks = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: rotated.body.refresh_token });
    expect(stillWorks.status).toBe(200);
  });

  it("revokes the whole family when a rotated token is replayed later", async () => {
    // Beyond the grace window, holding a token that has already been rotated
    // means the value leaked. Signing the legitimate holder out too is the
    // correct trade against leaving an attacker with a live session.
    const rotated = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });

    // Age the rotation past the grace window.
    await RefreshToken.updateMany(
      { revoked_at: { $exists: true } },
      { $set: { revoked_at: new Date(Date.now() - 60 * 60 * 1000) } }
    );

    const replay = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: tokens.refresh_token });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("token_reused");

    const afterBreach = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: rotated.body.refresh_token });

    expect(afterBreach.status).toBe(401);
  });

  it("rejects an unknown refresh token", async () => {
    const res = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: "not-a-real-token" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_refresh_token");
  });

  it("stores only the hash of a refresh token", async () => {
    const stored = await RefreshToken.findOne({
      token_hash: sha256(tokens.refresh_token),
    });
    expect(stored).toBeTruthy();

    const raw = await RefreshToken.findOne({ token_hash: tokens.refresh_token });
    expect(raw).toBeNull();
  });
});

describe("logout", () => {
  it("revokes the presented token and stays quiet about unknown ones", async () => {
    const { body } = await register("v2logout@example.com");

    const out = await request(app)
      .post("/api/v2/auth/logout")
      .send({ refresh_token: body.refresh_token });
    expect(out.status).toBe(200);

    const refresh = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: body.refresh_token });
    expect(refresh.status).toBe(401);

    const unknown = await request(app)
      .post("/api/v2/auth/logout")
      .send({ refresh_token: "never-existed" });
    expect(unknown.status).toBe(200);
  });
});

describe("password reset", () => {
  it("answers the same whether or not the address exists", async () => {
    await register("v2reset@example.com");

    const known = await request(app)
      .post("/api/v2/auth/password/forgot")
      .send({ email: "v2reset@example.com" });
    const unknown = await request(app)
      .post("/api/v2/auth/password/forgot")
      .send({ email: "v2nobody@example.com" });

    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });

  it("resets the password, ends every session, and cannot be replayed", async () => {
    const registered = await register("v2resetflow@example.com");

    await request(app)
      .post("/api/v2/auth/password/forgot")
      .send({ email: "v2resetflow@example.com" });

    const user = await User.findOne({ email_norm: "v2resetflow@example.com" });
    const record = await PasswordReset.findOne({ user_id: user._id });
    expect(record).toBeTruthy();

    // The stored value is a hash, so the token itself is reconstructed here
    // the way the email would have carried it.
    const rawToken = "reset-token-under-test";
    record.token_hash = sha256(rawToken);
    await record.save();

    const reset = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: rawToken, password: "a-brand-new-password" });
    expect(reset.status).toBe(200);

    const replay = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: rawToken, password: "another-password" });
    expect(replay.status).toBe(400);

    // Access tokens issued before the reset stop working immediately.
    const stale = await request(app)
      .get("/api/v2/me")
      .set("Authorization", `Bearer ${registered.body.access_token}`);
    expect(stale.status).toBe(401);

    const oldRefresh = await request(app)
      .post("/api/v2/auth/refresh")
      .send({ refresh_token: registered.body.refresh_token });
    expect(oldRefresh.status).toBe(401);

    const signIn = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "v2resetflow@example.com", password: "a-brand-new-password" });
    expect(signIn.status).toBe(200);
  });

  it("rejects an expired reset token", async () => {
    await register("v2resetexpired@example.com");
    await request(app)
      .post("/api/v2/auth/password/forgot")
      .send({ email: "v2resetexpired@example.com" });

    const user = await User.findOne({ email_norm: "v2resetexpired@example.com" });
    const record = await PasswordReset.findOne({ user_id: user._id });
    record.token_hash = sha256("expired-token");
    record.expires_at = new Date(Date.now() - 1000);
    await record.save();

    const res = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "expired-token", password: "yet-another-password" });
    expect(res.status).toBe(400);
  });
});

describe("authenticated access", () => {
  it("requires a bearer token", async () => {
    const res = await request(app).get("/api/v2/me");
    expect(res.status).toBe(401);
  });

  it("rejects a garbage token", async () => {
    const res = await request(app)
      .get("/api/v2/me")
      .set("Authorization", "Bearer not.a.jwt");
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const jwt = require("jsonwebtoken");
    const forged = jwt.sign({ sub: "aaaaaaaaaaaaaaaaaaaaaaaa", tv: 0 }, "some-other-secret");
    const res = await request(app)
      .get("/api/v2/me")
      .set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("returns the profile for a valid token", async () => {
    const { body } = await register("v2me@example.com");
    const res = await request(app)
      .get("/api/v2/me")
      .set("Authorization", `Bearer ${body.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("v2me@example.com");
    expect(res.body.user).not.toHaveProperty("password");
  });
});
