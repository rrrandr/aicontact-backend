import request from "supertest";
import { createApp } from "../../src/app";
import { WebhookEvent } from "../../src/models/webhookEvent";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { User } from "../../src/models/user";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import * as entitlementService from "../../src/v2/services/entitlementService";
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
const PASSWORD = "a-sufficiently-long-password";

describeIfSsl("webhook delivery recovery", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const appleNotification = (type, transaction, uuid) =>
    signApple({
      notificationType: type,
      notificationUUID: uuid,
      data: {
        bundleId: "com.FaceStreamCorporation.AICONTACT",
        environment: "Production",
        signedTransactionInfo: signApple(transaction),
        signedRenewalInfo: signApple({ autoRenewStatus: 1 }),
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

  const withSignature = (req) =>
    req
      .set("paypal-auth-algo", "SHA256withRSA")
      .set("paypal-cert-url", "https://api.paypal.com/cert")
      .set("paypal-transmission-id", "t-1")
      .set("paypal-transmission-sig", "sig")
      .set("paypal-transmission-time", new Date().toISOString());

  const verifyRoute = {
    "/v1/notifications/verify-webhook-signature": { body: { verification_status: "SUCCESS" } },
  };

  beforeAll(() => {
    process.env.APPLE_ROOT_CERTS = appleCerts().trusted.rootDer;
  });

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
    jest.restoreAllMocks();
  });

  describe("an event that failed mid-processing is retried, not swallowed", () => {
    it("recovers an Apple notification whose processing threw", async () => {
      const tokens = await register("recover-apple@example.com");
      const transaction = appleTransaction({ originalTransactionId: "9000000000000001" });
      await linkApple(tokens, transaction);

      const expired = { ...transaction, expiresDate: Date.now() - DAY };
      const payload = appleNotification("EXPIRED", expired, "uuid-recover-apple-1");

      // Fail once, the way a transient database or provider error would.
      const spy = jest
        .spyOn(entitlementService, "upsertEntitlement")
        .mockRejectedValueOnce(new Error("transient failure"));

      const first = await request(app)
        .post("/api/v2/webhooks/apple")
        .send({ signedPayload: payload });

      // Apple retries anything that is not a 2xx; it must be told to.
      expect(first.status).toBeGreaterThanOrEqual(500);

      const record = await WebhookEvent.findOne({ event_id: "uuid-recover-apple-1" });
      expect(record).toBeTruthy();
      expect(record.processed_at).toBeFalsy();

      spy.mockRestore();

      const retry = await request(app)
        .post("/api/v2/webhooks/apple")
        .send({ signedPayload: payload });

      expect(retry.status).toBe(200);
      expect(retry.body.duplicate).toBeUndefined();

      const after = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(after.body.entitlement.active).toBe(false);

      const settled = await WebhookEvent.findOne({ event_id: "uuid-recover-apple-1" });
      expect(settled.processed_at).toBeTruthy();
    });

    it("still refuses to process a completed event twice", async () => {
      const tokens = await register("recover-apple-done@example.com");
      const transaction = appleTransaction({ originalTransactionId: "9000000000000002" });
      await linkApple(tokens, transaction);

      const payload = appleNotification(
        "EXPIRED",
        { ...transaction, expiresDate: Date.now() - DAY },
        "uuid-recover-apple-2"
      );

      const first = await request(app).post("/api/v2/webhooks/apple").send({ signedPayload: payload });
      expect(first.status).toBe(200);

      const second = await request(app).post("/api/v2/webhooks/apple").send({ signedPayload: payload });
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);

      expect(await WebhookEvent.countDocuments({ event_id: "uuid-recover-apple-2" })).toBe(1);
    });

    it("allows only one processor while a delivery is in flight", async () => {
      const tokens = await register("recover-concurrent@example.com");
      const transaction = appleTransaction({ originalTransactionId: "9000000000000003" });
      await linkApple(tokens, transaction);

      const payload = appleNotification(
        "EXPIRED",
        { ...transaction, expiresDate: Date.now() - DAY },
        "uuid-recover-concurrent"
      );

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).post("/api/v2/webhooks/apple").send({ signedPayload: payload })
        )
      );

      const processed = results.filter((r) => r.status === 200 && !r.body.duplicate);
      expect(processed).toHaveLength(1);
      expect(await WebhookEvent.countDocuments({ event_id: "uuid-recover-concurrent" })).toBe(1);
    });

    it("recovers a PayPal event whose processing threw", async () => {
      const tokens = await register("recover-pp@example.com");
      const user = await User.findOne({ email_norm: "recover-pp@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-RECOVER0001", custom_id: user.subject_id }),
        },
      });
      await request(app)
        .post("/api/v2/entitlements/paypal/link")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-RECOVER0001" });

      const cancelledRoutes = {
        ...paypalAuthRoute,
        ...verifyRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-RECOVER0001", status: "CANCELLED" }),
        },
      };
      installFetchStub(cancelledRoutes);

      const body = {
        id: "evt-recover-1",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: paypalSubscription({ id: "I-RECOVER0001", status: "CANCELLED" }),
      };

      const spy = jest
        .spyOn(entitlementService, "upsertEntitlement")
        .mockRejectedValueOnce(new Error("transient failure"));

      const first = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send(body);
      expect(first.status).toBeGreaterThanOrEqual(500);

      spy.mockRestore();
      installFetchStub(cancelledRoutes);

      const retry = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send(body);
      expect(retry.status).toBe(200);

      // The retry, not the first delivery, is what recorded the cancellation.
      // Access is preserved to the period already paid for, so the evidence
      // that the event was processed is that renewal stopped.
      const after = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(after.body.entitlement.auto_renew).toBe(false);

      const record = await PaypalSubscription.findOne({ subscription_id: "I-RECOVER0001" });
      expect(record.cancelled_at).toBeTruthy();
    });
  });

  describe("PayPal renewals keep entitlement current", () => {
    it("extends entitlement when a recurring payment completes", async () => {
      // next_billing_time is the expiry. If renewal events are ignored it goes
      // stale and a paying subscriber loses access at the next billing date.
      const tokens = await register("renew-pp@example.com");
      const user = await User.findOne({ email_norm: "renew-pp@example.com" });

      const soon = new Date(Date.now() + 2 * DAY).toISOString();
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-RENEW00001",
            custom_id: user.subject_id,
            billing_info: { next_billing_time: soon },
          }),
        },
      });

      await request(app)
        .post("/api/v2/entitlements/paypal/link")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-RENEW00001" });

      const before = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(before.body.entitlement.days_remaining).toBeLessThanOrEqual(3);

      // PayPal takes the payment and moves the billing date on a month.
      const later = new Date(Date.now() + 32 * DAY).toISOString();
      installFetchStub({
        ...paypalAuthRoute,
        ...verifyRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-RENEW00001",
            custom_id: user.subject_id,
            billing_info: { next_billing_time: later },
          }),
        },
      });

      const hook = await withSignature(request(app).post("/api/v2/webhooks/paypal")).send({
        id: "evt-renew-1",
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: { billing_agreement_id: "I-RENEW00001", state: "completed" },
      });
      expect(hook.status).toBe(200);

      const after = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(after.body.entitlement.active).toBe(true);
      expect(after.body.entitlement.days_remaining).toBeGreaterThan(30);
    });

    it("refreshes from PayPal rather than trusting the event body", async () => {
      const tokens = await register("renew-pp-authoritative@example.com");
      const user = await User.findOne({ email_norm: "renew-pp-authoritative@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-RENEW00002", custom_id: user.subject_id }),
        },
      });
      await request(app)
        .post("/api/v2/entitlements/paypal/link")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-RENEW00002" });

      // The event claims the subscription is active; PayPal says cancelled.
      installFetchStub({
        ...paypalAuthRoute,
        ...verifyRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-RENEW00002",
            custom_id: user.subject_id,
            status: "CANCELLED",
            billing_info: {},
          }),
        },
      });

      await withSignature(request(app).post("/api/v2/webhooks/paypal")).send({
        id: "evt-renew-2",
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: { billing_agreement_id: "I-RENEW00002", state: "completed" },
      });

      const after = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      // Had the event body been believed, this would still be renewing. The
      // paid period is preserved, but nothing will be charged again.
      expect(after.body.entitlement.auto_renew).toBe(false);

      const record = await PaypalSubscription.findOne({ subscription_id: "I-RENEW00002" });
      expect(record.status).toBe("CANCELLED");
      expect(record.cancelled_at).toBeTruthy();
    });
  });
});
