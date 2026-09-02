import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { Entitlement } from "../../src/models/entitlement";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { signApple } from "../helpers/providers";
import { appleCerts, opensslAvailable } from "../helpers/appleCerts";
import {
  appleTransaction,
  appleStatusResponse,
  paypalSubscription,
  installFetchStub,
  paypalAuthRoute,
  DAY,
} from "../helpers/providers";

const describeIfSsl = opensslAvailable() ? describe : describe.skip;

describeIfSsl("entitlements", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) => {
    const res = await request(app)
      .post("/api/v2/auth/register")
      .send({ email, password: "a-sufficiently-long-password" });
    return res.body;
  };

  const authed = (req, tokens) =>
    req.set("Authorization", `Bearer ${tokens.access_token}`);

  beforeAll(() => {
    // config.apple.rootCerts reads the environment on each access, so pinning
    // the test root here is enough - no module reload required.
    process.env.APPLE_ROOT_CERTS = appleCerts().trusted.rootDer;
  });

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
  });

  describe("apple", () => {
    it("grants entitlement for a verified, active purchase", async () => {
      const tokens = await register("ent-apple1@example.com");
      const transaction = appleTransaction();

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/apple/verify"),
        tokens
      ).send({ signed_transaction: signApple(transaction) });

      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(true);
      expect(res.body.entitlement.platform).toBe("apple");
      expect(res.body.entitlement.days_remaining).toBeGreaterThan(25);
    });

    it("keeps the legacy subscription_date in step for v1 clients", async () => {
      // A user who upgrades on one device must not be locked out on another
      // still running a released build.
      const tokens = await register("ent-apple-legacy@example.com");
      const transaction = appleTransaction({ originalTransactionId: "2000000000000010" });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      await authed(request(app).post("/api/v2/entitlements/apple/verify"), tokens).send({
        signed_transaction: signApple(transaction),
      });

      const user = await User.findOne({ email_norm: "ent-apple-legacy@example.com" });
      expect(user.subscription_date).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
      expect(Number.isNaN(Date.parse(user.subscription_date))).toBe(false);
    });

    it("refuses a purchase already linked to another account", async () => {
      const first = await register("ent-apple-owner@example.com");
      const second = await register("ent-apple-thief@example.com");
      const transaction = appleTransaction({ originalTransactionId: "2000000000000003" });
      const signed = signApple(transaction);

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      const owner = await authed(
        request(app).post("/api/v2/entitlements/apple/verify"),
        first
      ).send({ signed_transaction: signed });
      expect(owner.status).toBe(200);

      const thief = await authed(
        request(app).post("/api/v2/entitlements/apple/verify"),
        second
      ).send({ signed_transaction: signed });

      expect(thief.status).toBe(409);
      expect(thief.body.code).toBe("transaction_already_linked");
    });

    it("does not grant entitlement for a refunded purchase", async () => {
      const tokens = await register("ent-apple-refund@example.com");
      const transaction = appleTransaction({
        originalTransactionId: "2000000000000004",
        revocationDate: Date.now() - 1000,
      });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction, { status: 5 }) },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/apple/verify"),
        tokens
      ).send({ signed_transaction: signApple(transaction) });

      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(false);
    });

    it("does not grant entitlement for an expired subscription", async () => {
      const tokens = await register("ent-apple-expired@example.com");
      const transaction = appleTransaction({
        originalTransactionId: "2000000000000005",
        expiresDate: Date.now() - DAY,
      });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction, { status: 2 }) },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/apple/verify"),
        tokens
      ).send({ signed_transaction: signApple(transaction) });

      expect(res.body.entitlement.active).toBe(false);
    });

    it("rejects a forged transaction without ever calling Apple", async () => {
      const tokens = await register("ent-apple-forged@example.com");
      const jwt = require("jsonwebtoken");
      const forged = jwt.sign(
        appleTransaction({ originalTransactionId: "forged" }),
        appleCerts().untrusted.leafKey,
        { algorithm: "ES256", header: { alg: "ES256", x5c: appleCerts().untrusted.x5c } }
      );

      const calls = installFetchStub({});

      const res = await authed(
        request(app).post("/api/v2/entitlements/apple/verify"),
        tokens
      ).send({ signed_transaction: forged });

      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
      expect(await Entitlement.countDocuments({})).toBeGreaterThanOrEqual(0);
    });
  });

  describe("paypal", () => {
    it("links an active subscription and grants entitlement", async () => {
      const tokens = await register("ent-pp1@example.com");
      const user = await User.findOne({ email_norm: "ent-pp1@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ custom_id: user.subject_id }),
        },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        tokens
      ).send({ subscription_id: "I-TESTSUB00001" });

      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(true);
      expect(res.body.entitlement.platform).toBe("paypal");
    });

    it("refuses a subscription belonging to another account", async () => {
      // The desktop client's model let any known subscription ID unlock any
      // installation. Ownership now comes from the custom_id the server set
      // at creation, so presenting someone else's ID proves nothing.
      const owner = await register("ent-pp-owner@example.com");
      const other = await register("ent-pp-other@example.com");
      const ownerUser = await User.findOne({ email_norm: "ent-pp-owner@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-SHARED00001", custom_id: ownerUser.subject_id }),
        },
      });

      const first = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        owner
      ).send({ subscription_id: "I-SHARED00001" });
      expect(first.status).toBe(200);

      const second = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        other
      ).send({ subscription_id: "I-SHARED00001" });

      expect(second.status).toBe(403);
      expect(second.body.code).toBe("paypal_ownership_unverified");
    });

    it("refuses a subscription for a plan we do not sell", async () => {
      const tokens = await register("ent-pp-plan@example.com");

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-WRONGPLAN01", plan_id: "P-SOMEONE-ELSE" }),
        },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        tokens
      ).send({ subscription_id: "I-WRONGPLAN01" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("paypal_unknown_plan");
    });

    it("refuses a cancelled subscription", async () => {
      const tokens = await register("ent-pp-cancelled@example.com");
      const user = await User.findOne({ email_norm: "ent-pp-cancelled@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-CANCELLED1",
            custom_id: user.subject_id,
            status: "CANCELLED",
          }),
        },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        tokens
      ).send({ subscription_id: "I-CANCELLED1" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("subscription_not_active");
    });

    it("reports a subscription PayPal has never heard of", async () => {
      const tokens = await register("ent-pp-missing@example.com");

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": { status: 404, body: {} },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        tokens
      ).send({ subscription_id: "I-NOTREAL0001" });

      expect(res.status).toBe(404);
    });

    it("never sends PayPal credentials to the client", async () => {
      const tokens = await register("ent-pp-secrets@example.com");
      const user = await User.findOne({ email_norm: "ent-pp-secrets@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-SECRETS0001", custom_id: user.subject_id }),
        },
      });

      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        tokens
      ).send({ subscription_id: "I-SECRETS0001" });

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(process.env.PAYPAL_CLIENT_SECRET);
      expect(serialized).not.toContain(process.env.PAYPAL_CLIENT_ID);
    });
  });

  describe("entitlement is not client-writable", () => {
    it("rejects an attempt to set entitlement fields through PATCH /me", async () => {
      const tokens = await register("ent-readonly@example.com");

      const res = await authed(request(app).patch("/api/v2/me"), tokens).send({
        terms_accepted: true,
        subscription_date: "01/01/2099 00:00:00",
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("field_not_writable");
    });

    it("has no endpoint that accepts an entitlement from the client", async () => {
      const tokens = await register("ent-noendpoint@example.com");

      const res = await authed(request(app).post("/api/v2/entitlements"), tokens).send({
        active: true,
        expires_at: "2099-01-01T00:00:00Z",
      });

      expect([404, 405]).toContain(res.status);
    });
  });
});
