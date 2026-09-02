import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { Entitlement } from "../../src/models/entitlement";
import { AppleTransaction } from "../../src/models/appleTransaction";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { WebhookEvent } from "../../src/models/webhookEvent";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import {
  signApple,
  appleTransaction,
  appleStatusResponse,
  paypalSubscription,
  installFetchStub,
  paypalAuthRoute,
  DAY,
} from "../helpers/providers";
import { appleCerts, opensslAvailable } from "../helpers/appleCerts";

const describeIfSsl = opensslAvailable() ? describe : describe.skip;

describeIfSsl("webhooks", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (
      await request(app)
        .post("/api/v2/auth/register")
        .send({ email, password: "a-sufficiently-long-password" })
    ).body;

  const appleNotification = (type, transaction, renewal = { autoRenewStatus: 1 }) =>
    signApple({
      notificationType: type,
      notificationUUID: `uuid-${type}-${transaction.originalTransactionId}`,
      data: {
        bundleId: "com.FaceStreamCorporation.AICONTACT",
        environment: "Production",
        signedTransactionInfo: signApple(transaction),
        signedRenewalInfo: signApple(renewal),
      },
    });

  const linkApple = async (tokens, transaction) => {
    installFetchStub({
      "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
    });
    const res = await request(app)
      .post("/api/v2/entitlements/apple/verify")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ signed_transaction: signApple(transaction) });
    global.fetch = realFetch;
    return res;
  };

  beforeAll(() => {
    process.env.APPLE_ROOT_CERTS = appleCerts().trusted.rootDer;
  });

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
  });

  describe("apple", () => {
    it("rejects a notification it cannot verify", async () => {
      const forged = require("jsonwebtoken").sign(
        { notificationType: "DID_RENEW", notificationUUID: "forged-uuid" },
        appleCerts().untrusted.leafKey,
        { algorithm: "ES256", header: { alg: "ES256", x5c: appleCerts().untrusted.x5c } }
      );

      const res = await request(app)
        .post("/api/v2/webhooks/apple")
        .send({ signedPayload: forged });

      expect(res.status).toBe(400);
      expect(await WebhookEvent.findOne({ event_id: "forged-uuid" })).toBeNull();
    });

    it("revokes entitlement on REFUND", async () => {
      const tokens = await register("wh-apple-refund@example.com");
      const transaction = appleTransaction({ originalTransactionId: "3000000000000001" });
      await linkApple(tokens, transaction);

      const before = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(before.body.entitlement.active).toBe(true);

      const res = await request(app)
        .post("/api/v2/webhooks/apple")
        .send({
          signedPayload: appleNotification("REFUND", {
            ...transaction,
            revocationDate: Date.now(),
          }),
        });
      expect(res.status).toBe(200);

      const after = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(after.body.entitlement.active).toBe(false);
    });

    it("extends entitlement on DID_RENEW", async () => {
      const tokens = await register("wh-apple-renew@example.com");
      const transaction = appleTransaction({ originalTransactionId: "3000000000000002" });
      await linkApple(tokens, transaction);

      const renewed = {
        ...transaction,
        expiresDate: Date.now() + 60 * DAY,
      };

      await request(app)
        .post("/api/v2/webhooks/apple")
        .send({ signedPayload: appleNotification("DID_RENEW", renewed) });

      const res = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(res.body.entitlement.active).toBe(true);
      expect(res.body.entitlement.days_remaining).toBeGreaterThan(50);
    });

    it("processes a duplicate notification exactly once", async () => {
      const tokens = await register("wh-apple-dupe@example.com");
      const transaction = appleTransaction({ originalTransactionId: "3000000000000003" });
      await linkApple(tokens, transaction);

      const payload = appleNotification("EXPIRED", {
        ...transaction,
        expiresDate: Date.now() - DAY,
      });

      const first = await request(app).post("/api/v2/webhooks/apple").send({ signedPayload: payload });
      const second = await request(app).post("/api/v2/webhooks/apple").send({ signedPayload: payload });

      expect(first.status).toBe(200);
      expect(first.body.duplicate).toBeUndefined();
      // Acknowledged, not reprocessed - a non-2xx would make Apple retry.
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);

      expect(
        await WebhookEvent.countDocuments({ provider: "apple", event_id: `uuid-EXPIRED-${transaction.originalTransactionId}` })
      ).toBe(1);
    });

    it("acknowledges a notification for a purchase nobody has claimed", async () => {
      const transaction = appleTransaction({ originalTransactionId: "3000000000000099" });

      const res = await request(app)
        .post("/api/v2/webhooks/apple")
        .send({ signedPayload: appleNotification("DID_RENEW", transaction) });

      expect(res.status).toBe(200);
      expect(res.body.unlinked).toBe(true);
      // The state is kept so it is not lost before the client verifies.
      expect(
        await AppleTransaction.findOne({ original_transaction_id: "3000000000000099" })
      ).toBeTruthy();
    });
  });

  describe("paypal", () => {
    const withSignature = (req) =>
      req
        .set("paypal-auth-algo", "SHA256withRSA")
        .set("paypal-cert-url", "https://api.paypal.com/cert")
        .set("paypal-transmission-id", "t-1")
        .set("paypal-transmission-sig", "sig")
        .set("paypal-transmission-time", new Date().toISOString());

    const verifyRoute = (status) => ({
      "/v1/notifications/verify-webhook-signature": {
        body: { verification_status: status },
      },
    });

    // Ownership is proved by custom_id, which the server sets when it creates
    // the subscription. Without it the link is refused and these tests would
    // silently exercise the unlinked path instead.
    const linkPaypal = async (tokens, subscriptionId, email) => {
      const user = await User.findOne({ email_norm: email });
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: subscriptionId, custom_id: user.subject_id }),
        },
      });
      const res = await request(app)
        .post("/api/v2/entitlements/paypal/link")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: subscriptionId });
      global.fetch = realFetch;
      resetTokenCache();
      expect(res.status).toBe(200);
      return { res, subjectId: user.subject_id };
    };

    it("rejects an event whose signature does not verify", async () => {
      installFetchStub({ ...paypalAuthRoute, ...verifyRoute("FAILURE") });

      const res = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send({
        id: "evt-bad-1",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: { id: "I-ANY" },
      });

      expect(res.status).toBe(400);
      expect(await WebhookEvent.findOne({ event_id: "evt-bad-1" })).toBeNull();
    });

    it("rejects an event with no signature headers at all", async () => {
      installFetchStub({ ...paypalAuthRoute, ...verifyRoute("SUCCESS") });

      const res = await request(app).post("/api/v2/webhooks/paypal").send({
        id: "evt-nosig",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: { id: "I-ANY" },
      });

      expect(res.status).toBe(400);
    });

    it("ends entitlement when a subscription is cancelled", async () => {
      const tokens = await register("wh-pp-cancel@example.com");
      const { subjectId } = await linkPaypal(
        tokens,
        "I-WHCANCEL001",
        "wh-pp-cancel@example.com"
      );

      installFetchStub({
        ...paypalAuthRoute,
        ...verifyRoute("SUCCESS"),
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-WHCANCEL001",
            custom_id: subjectId,
            status: "CANCELLED",
          }),
        },
      });

      const res = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send({
        id: "evt-cancel-1",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: paypalSubscription({ id: "I-WHCANCEL001", status: "CANCELLED" }),
      });
      expect(res.status).toBe(200);

      const after = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(after.body.entitlement.active).toBe(false);
    });

    it("processes a duplicate event exactly once", async () => {
      const tokens = await register("wh-pp-dupe@example.com");
      const { subjectId } = await linkPaypal(
        tokens,
        "I-WHDUPE0001",
        "wh-pp-dupe@example.com"
      );

      installFetchStub({
        ...paypalAuthRoute,
        ...verifyRoute("SUCCESS"),
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-WHDUPE0001",
            custom_id: subjectId,
            status: "SUSPENDED",
          }),
        },
      });

      const body = {
        id: "evt-dupe-1",
        event_type: "BILLING.SUBSCRIPTION.SUSPENDED",
        resource: paypalSubscription({ id: "I-WHDUPE0001", status: "SUSPENDED" }),
      };

      const first = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send(body);
      const second = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send(body);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);
      expect(await WebhookEvent.countDocuments({ event_id: "evt-dupe-1" })).toBe(1);
    });

    it("acknowledges an event for a subscription nobody has linked", async () => {
      installFetchStub({ ...paypalAuthRoute, ...verifyRoute("SUCCESS") });

      const res = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send({
        id: "evt-unlinked-1",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: paypalSubscription({ id: "I-NEVERLINKED" }),
      });

      expect(res.status).toBe(200);
      expect(res.body.unlinked).toBe(true);
    });
  });
});
