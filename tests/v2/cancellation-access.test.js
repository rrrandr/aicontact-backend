import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { Entitlement } from "../../src/models/entitlement";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { paypalSubscription, installFetchStub, paypalAuthRoute, DAY } from "../helpers/providers";

const PASSWORD = "a-sufficiently-long-password";

/**
 * The interaction between a cancellation and the webhook that follows it.
 *
 * PayPal sends BILLING.SUBSCRIPTION.CANCELLED moments after the cancel call
 * succeeds, and by then its record no longer carries a next billing time. A
 * handler that recomputes expiry from what it is given would therefore revoke
 * the period the subscriber has already paid for - and because providers
 * replay events, it would do it on every retry.
 */
describe("a cancellation webhook cannot shorten preserved access", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const withSignature = (req) =>
    req
      .set("paypal-auth-algo", "SHA256withRSA")
      .set("paypal-cert-url", "https://api.paypal.com/cert")
      .set("paypal-transmission-id", `t-${Math.random()}`)
      .set("paypal-transmission-sig", "sig")
      .set("paypal-transmission-time", new Date().toISOString());

  const verifyRoute = {
    "/v1/notifications/verify-webhook-signature": { body: { verification_status: "SUCCESS" } },
  };

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
  });

  const subscribeAndCancel = async ({ email, id, endsInDays = 18 }) => {
    const tokens = (
      await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })
    ).body;
    const user = await User.findOne({ email_norm: email });
    const endsAt = new Date(Date.now() + endsInDays * DAY);

    let cancelled = false;
    const routes = {
      ...paypalAuthRoute,
      ...verifyRoute,
      "/v1/billing/subscriptions/": (url) => {
        if (String(url).endsWith("/cancel")) {
          cancelled = true;
          return { status: 204, body: {} };
        }
        return cancelled
          ? { body: paypalSubscription({ id, status: "CANCELLED", billing_info: {} }) }
          : {
              body: paypalSubscription({
                id,
                custom_id: user.subject_id,
                status: "ACTIVE",
                billing_info: { next_billing_time: endsAt.toISOString() },
              }),
            };
      },
    };
    installFetchStub(routes);

    await request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: id });

    const cancelRes = await request(app)
      .post("/api/v2/entitlements/paypal/cancel")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(cancelRes.status).toBe(200);

    // Reinstall, because the link call consumed the stub's closure state.
    installFetchStub(routes);

    return { tokens, user, endsAt, id };
  };

  const sendCancelledEvent = (id, eventId) =>
    withSignature(request(app).post("/api/v2/webhooks/paypal")).send({
      id: eventId,
      event_type: "BILLING.SUBSCRIPTION.CANCELLED",
      resource: paypalSubscription({ id, status: "CANCELLED", billing_info: {} }),
    });

  it("leaves the recorded access-end date exactly where it was", async () => {
    const { user, endsAt, id } = await subscribeAndCancel({
      email: "wh-preserve@example.com",
      id: "I-PRESERVE001",
    });

    const res = await sendCancelledEvent(id, "evt-preserve-1");
    expect(res.status).toBe(200);

    const entitlement = await Entitlement.findOne({ user_id: user._id });
    expect(entitlement.access_ends_at.getTime()).toBe(endsAt.getTime());
    expect(entitlement.expires_at.getTime()).toBe(endsAt.getTime());
    expect(entitlement.status).toBe("active");
  });

  it("keeps the subscriber entitled right after the notification arrives", async () => {
    const { tokens, id } = await subscribeAndCancel({
      email: "wh-preserve-entitled@example.com",
      id: "I-PRESERVE002",
    });

    await sendCancelledEvent(id, "evt-preserve-2");

    const after = await request(app)
      .get("/api/v2/entitlements")
      .set("Authorization", `Bearer ${tokens.access_token}`);

    expect(after.body.entitlement.active).toBe(true);
    expect(after.body.entitlement.auto_renew).toBe(false);
    expect(after.body.entitlement.days_remaining).toBeGreaterThan(1);
  });

  it("survives the event being replayed", async () => {
    // Providers retry. Idempotence here is not a nicety: each replay is another
    // chance to overwrite a good date with a missing one.
    const { user, endsAt, id } = await subscribeAndCancel({
      email: "wh-preserve-replay@example.com",
      id: "I-PRESERVE003",
    });

    for (const eventId of ["evt-replay-a", "evt-replay-b", "evt-replay-c"]) {
      const res = await sendCancelledEvent(id, eventId);
      expect(res.status).toBe(200);
    }

    const entitlement = await Entitlement.findOne({ user_id: user._id });
    expect(entitlement.access_ends_at.getTime()).toBe(endsAt.getTime());
    expect(entitlement.status).toBe("active");
  });

  it("does not overwrite the source we recorded with the provider's", async () => {
    const { user, id } = await subscribeAndCancel({
      email: "wh-preserve-source@example.com",
      id: "I-PRESERVE004",
    });

    await sendCancelledEvent(id, "evt-preserve-4");

    const record = await PaypalSubscription.findOne({ subscription_id: id });
    expect(record.cancellation_source).toBe("user");
  });

  it("still lets a refund end access immediately", async () => {
    // Preservation is about a period that was paid for. A refund is a
    // statement that it was not, and must not be held off by the floor.
    const { user, id } = await subscribeAndCancel({
      email: "wh-preserve-refund@example.com",
      id: "I-PRESERVE005",
    });

    await Entitlement.updateOne({ user_id: user._id }, { $set: { status: "refunded" } });

    const entitlement = await Entitlement.findOne({ user_id: user._id });
    // The floor is still recorded, but a refunded row grants nothing.
    expect(entitlement.access_ends_at).toBeTruthy();

    const { isActive } = require("../../src/v2/services/entitlementService");
    expect(isActive(entitlement)).toBe(false);
  });
});
