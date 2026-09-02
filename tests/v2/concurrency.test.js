import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { RefreshToken } from "../../src/models/refreshToken";
import { PasswordReset } from "../../src/models/passwordReset";
import { AppleTransaction } from "../../src/models/appleTransaction";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { PaypalLegacyClaim } from "../../src/models/paypalLegacyClaim";
import { sha256 } from "../../src/util/crypto";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import {
  signApple,
  appleTransaction,
  appleStatusResponse,
  paypalSubscription,
  installFetchStub,
  paypalAuthRoute,
} from "../helpers/providers";
import { appleCerts, opensslAvailable } from "../helpers/appleCerts";

const describeIfSsl = opensslAvailable() ? describe : describe.skip;
const PASSWORD = "a-sufficiently-long-password";
const PARALLEL = 6;

/**
 * These fire genuinely simultaneous requests. Every case here is a
 * check-then-act window: two requests both read a record as unclaimed or
 * unrevoked, and both then write. A single sequential request never shows it.
 */
describeIfSsl("concurrent requests", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const countBy = (results, status) => results.filter((r) => r.status === status).length;

  beforeAll(() => {
    process.env.APPLE_ROOT_CERTS = appleCerts().trusted.rootDer;
  });

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
    process.env.PAYPAL_LEGACY_CLAIM_ENABLED = "false";
  });

  describe("subscription claiming", () => {
    it("gives an Apple purchase to exactly one of several racing accounts", async () => {
      const transaction = appleTransaction({ originalTransactionId: "8000000000000001" });
      const signed = signApple(transaction);

      const accounts = [];
      for (let i = 0; i < PARALLEL; i += 1) {
        accounts.push(await register(`race-apple-${i}@example.com`));
      }

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      const results = await Promise.all(
        accounts.map((tokens) =>
          request(app)
            .post("/api/v2/entitlements/apple/verify")
            .set("Authorization", `Bearer ${tokens.access_token}`)
            .send({ signed_transaction: signed })
        )
      );

      expect(countBy(results, 200)).toBe(1);
      expect(countBy(results, 409)).toBe(PARALLEL - 1);

      const rows = await AppleTransaction.find({
        original_transaction_id: "8000000000000001",
      });
      expect(rows).toHaveLength(1);
    });

    it("gives a legacy PayPal subscription to exactly one of several racing accounts", async () => {
      process.env.PAYPAL_LEGACY_CLAIM_ENABLED = "true";

      const accounts = [];
      for (let i = 0; i < PARALLEL; i += 1) {
        accounts.push(await register(`race-pp-${i}@example.com`));
      }

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-RACECLAIM01",
            subscriber: { email_address: "payer@example.com" },
          }),
        },
      });

      for (const tokens of accounts) {
        await request(app)
          .post("/api/v2/entitlements/paypal/claim-legacy/start")
          .set("Authorization", `Bearer ${tokens.access_token}`)
          .send({ subscription_id: "I-RACECLAIM01" });
      }

      // Everyone holds a valid code; only one may end up owning it.
      await PaypalLegacyClaim.updateMany(
        { subscription_id: "I-RACECLAIM01" },
        { $set: { code_hash: sha256("123456") } }
      );

      const results = await Promise.all(
        accounts.map((tokens) =>
          request(app)
            .post("/api/v2/entitlements/paypal/claim-legacy/confirm")
            .set("Authorization", `Bearer ${tokens.access_token}`)
            .send({ subscription_id: "I-RACECLAIM01", code: "123456" })
        )
      );

      expect(countBy(results, 200)).toBe(1);

      const rows = await PaypalSubscription.find({ subscription_id: "I-RACECLAIM01" });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeTruthy();
    });

    it("does not duplicate a record when one account links twice at once", async () => {
      const tokens = await register("race-self@example.com");
      const user = await User.findOne({ email_norm: "race-self@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-SELFRACE01", custom_id: user.subject_id }),
        },
      });

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          request(app)
            .post("/api/v2/entitlements/paypal/link")
            .set("Authorization", `Bearer ${tokens.access_token}`)
            .send({ subscription_id: "I-SELFRACE01" })
        )
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await PaypalSubscription.countDocuments({ subscription_id: "I-SELFRACE01" })).toBe(1);
    });
  });

  describe("refresh token rotation", () => {
    it("lets exactly one of several simultaneous rotations succeed", async () => {
      const tokens = await register("race-refresh@example.com");

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          request(app)
            .post("/api/v2/auth/refresh")
            .send({ refresh_token: tokens.refresh_token })
        )
      );

      expect(countBy(results, 200)).toBe(1);

      const user = await User.findOne({ email_norm: "race-refresh@example.com" });
      // One successor, not one per racing request.
      const live = await RefreshToken.countDocuments({
        user_id: user._id,
        revoked_at: { $exists: false },
      });
      expect(live).toBe(1);
    });

    it("issues a token that still works after the race", async () => {
      const tokens = await register("race-refresh-usable@example.com");

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          request(app)
            .post("/api/v2/auth/refresh")
            .send({ refresh_token: tokens.refresh_token })
        )
      );

      const winner = results.find((r) => r.status === 200);
      expect(winner).toBeTruthy();

      const next = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: winner.body.refresh_token });

      expect(next.status).toBe(200);
    });
  });

  describe("password reset consumption", () => {
    it("lets exactly one of several simultaneous resets succeed", async () => {
      await register("race-reset@example.com");
      await request(app)
        .post("/api/v2/auth/password/forgot")
        .send({ email: "race-reset@example.com" });

      const user = await User.findOne({ email_norm: "race-reset@example.com" });
      await PasswordReset.updateOne(
        { user_id: user._id },
        { $set: { token_hash: sha256("known-reset-token") } }
      );

      const results = await Promise.all(
        Array.from({ length: PARALLEL }, (_unused, index) =>
          request(app)
            .post("/api/v2/auth/password/reset")
            .send({ token: "known-reset-token", password: `new-password-${index}` })
        )
      );

      expect(countBy(results, 200)).toBe(1);

      const record = await PasswordReset.findOne({ user_id: user._id });
      expect(record.used_at).toBeTruthy();
    });
  });
});
