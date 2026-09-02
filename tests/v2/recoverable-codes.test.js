import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { PasswordReset } from "../../src/models/passwordReset";
import { PaypalLegacyClaim } from "../../src/models/paypalLegacyClaim";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { sha256 } from "../../src/util/crypto";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { paypalSubscription, installFetchStub, paypalAuthRoute } from "../helpers/providers";

const app = createApp();
const realFetch = global.fetch;
const PASSWORD = "a-sufficiently-long-password";

const register = async (email) =>
  (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

afterEach(() => {
  global.fetch = realFetch;
  resetTokenCache();
  jest.restoreAllMocks();
  process.env.PAYPAL_LEGACY_CLAIM_ENABLED = "false";
});

describe("a password reset code survives a transient failure", () => {
  const startReset = async (email, rawToken) => {
    await register(email);
    await request(app).post("/api/v2/auth/password/forgot").send({ email });
    const user = await User.findOne({ email_norm: email });
    await PasswordReset.updateOne(
      { user_id: user._id },
      { $set: { token_hash: sha256(rawToken) } }
    );
    return user;
  };

  it("is not burned when the password write fails", async () => {
    // Consuming the code before the password is actually changed leaves the
    // user with neither a working password nor a usable reset link.
    const user = await startReset("recover-reset-1@example.com", "reset-token-1");

    jest
      .spyOn(User.prototype, "save")
      .mockRejectedValueOnce(new Error("transient write failure"));

    const failed = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "reset-token-1", password: "first-attempt-password" });

    expect(failed.status).toBeGreaterThanOrEqual(500);

    // The old password must still work, since nothing changed.
    const stillOld = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "recover-reset-1@example.com", password: PASSWORD });
    expect(stillOld.status).toBe(200);

    jest.restoreAllMocks();

    const retry = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "reset-token-1", password: "second-attempt-password" });

    expect(retry.status).toBe(200);

    const signIn = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "recover-reset-1@example.com", password: "second-attempt-password" });
    expect(signIn.status).toBe(200);

    const record = await PasswordReset.findOne({ user_id: user._id });
    expect(record.used_at).toBeTruthy();
  });

  it("still cannot be used twice once it has succeeded", async () => {
    await startReset("recover-reset-2@example.com", "reset-token-2");

    const first = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "reset-token-2", password: "new-password-once" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/v2/auth/password/reset")
      .send({ token: "reset-token-2", password: "new-password-twice" });
    expect(second.status).toBe(400);
  });

  it("lets only one of several simultaneous uses through", async () => {
    await startReset("recover-reset-3@example.com", "reset-token-3");

    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        request(app)
          .post("/api/v2/auth/password/reset")
          .send({ token: "reset-token-3", password: `parallel-password-${i}` })
      )
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

describe("a legacy PayPal claim code survives a transient failure", () => {
  const startClaim = async (email, subscriptionId, rawCode) => {
    process.env.PAYPAL_LEGACY_CLAIM_ENABLED = "true";
    const tokens = await register(email);

    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": {
        body: paypalSubscription({
          id: subscriptionId,
          subscriber: { email_address: "payer@example.com" },
        }),
      },
    });

    const start = await request(app)
      .post("/api/v2/entitlements/paypal/claim-legacy/start")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: subscriptionId });
    expect(start.status).toBe(202);

    const user = await User.findOne({ email_norm: email });
    await PaypalLegacyClaim.updateOne(
      { subscription_id: subscriptionId, user_id: user._id },
      { $set: { code_hash: sha256(rawCode) } }
    );

    return tokens;
  };

  it("is not burned when PayPal fails during confirmation", async () => {
    const tokens = await startClaim(
      "recover-claim-1@example.com",
      "I-RECOVERCLM1",
      "111111"
    );

    // PayPal is unreachable at the moment of confirmation.
    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": { status: 500, body: {} },
    });

    const failed = await request(app)
      .post("/api/v2/entitlements/paypal/claim-legacy/confirm")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-RECOVERCLM1", code: "111111" });

    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(
      await PaypalSubscription.findOne({ subscription_id: "I-RECOVERCLM1" })
    ).toBeNull();

    // PayPal recovers; the same code must still work.
    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": {
        body: paypalSubscription({
          id: "I-RECOVERCLM1",
          subscriber: { email_address: "payer@example.com" },
        }),
      },
    });

    const retry = await request(app)
      .post("/api/v2/entitlements/paypal/claim-legacy/confirm")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-RECOVERCLM1", code: "111111" });

    expect(retry.status).toBe(200);
    expect(retry.body.entitlement.active).toBe(true);
  });

  it("still cannot be replayed after a successful claim", async () => {
    const tokens = await startClaim(
      "recover-claim-2@example.com",
      "I-RECOVERCLM2",
      "222222"
    );

    const first = await request(app)
      .post("/api/v2/entitlements/paypal/claim-legacy/confirm")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-RECOVERCLM2", code: "222222" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/v2/entitlements/paypal/claim-legacy/confirm")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-RECOVERCLM2", code: "222222" });
    expect(second.status).toBe(400);
  });

  it("still refuses a wrong code", async () => {
    const tokens = await startClaim(
      "recover-claim-3@example.com",
      "I-RECOVERCLM3",
      "333333"
    );

    const wrong = await request(app)
      .post("/api/v2/entitlements/paypal/claim-legacy/confirm")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-RECOVERCLM3", code: "999999" });

    expect(wrong.status).toBe(400);
    expect(
      await PaypalSubscription.findOne({ subscription_id: "I-RECOVERCLM3" })
    ).toBeNull();
  });
});
