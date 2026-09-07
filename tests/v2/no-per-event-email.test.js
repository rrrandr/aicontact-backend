import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { Entitlement } from "../../src/models/entitlement";
import * as mailService from "../../src/v2/services/mailService";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { paypalSubscription, installFetchStub, paypalAuthRoute, DAY } from "../helpers/providers";

const PASSWORD = "a-sufficiently-long-password";

/**
 * The point of the weekly tally is that no business event mails the owner.
 *
 * A message per signup and a message per cancellation is what makes an inbox
 * useless, and an inbox nobody reads is not monitoring. These tests pin that
 * absence.
 *
 * They are not a claim that AICONTACT sends no customer mail. It sends four
 * kinds, each because something requires it - see customerMail.js and
 * customer-mail.test.js. What is pinned here is narrower and still true:
 * registering, signing in, cancelling and deleting an account each send
 * nothing, and the enrollment confirmation fires from the PayPal webhook
 * rather than from any of these paths.
 */
describe("signups and cancellations send no mail of their own", () => {
  const app = createApp();
  const realFetch = global.fetch;
  let sendMail;
  let sendPasswordReset;

  beforeEach(() => {
    sendMail = jest.spyOn(mailService, "sendMail").mockResolvedValue({ delivered: true });
    sendPasswordReset = jest
      .spyOn(mailService, "sendPasswordReset")
      .mockResolvedValue({ delivered: true });
  });

  afterEach(() => {
    sendMail.mockRestore();
    sendPasswordReset.mockRestore();
    global.fetch = realFetch;
    resetTokenCache();
  });

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  it("sends nothing when an account is created", async () => {
    await register("quiet-signup@example.com");
    expect(sendMail).not.toHaveBeenCalled();
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it("sends nothing when someone signs in", async () => {
    await register("quiet-login@example.com");
    sendMail.mockClear();

    await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "quiet-login@example.com", password: PASSWORD });

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends nothing when a subscription is approved or cancelled", async () => {
    const tokens = await register("quiet-cancel@example.com");
    const user = await User.findOne({ email_norm: "quiet-cancel@example.com" });
    const endsAt = new Date(Date.now() + 12 * DAY);

    let cancelled = false;
    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": (url) => {
        if (String(url).endsWith("/cancel")) {
          cancelled = true;
          return { status: 204, body: {} };
        }
        return cancelled
          ? { body: paypalSubscription({ id: "I-QUIET000001", status: "CANCELLED", billing_info: {} }) }
          : {
              body: paypalSubscription({
                id: "I-QUIET000001",
                custom_id: user.subject_id,
                status: "ACTIVE",
                billing_info: { next_billing_time: endsAt.toISOString() },
              }),
            };
      },
    });

    await request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-QUIET000001" });

    const cancelRes = await request(app)
      .post("/api/v2/entitlements/paypal/cancel")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});

    expect(cancelRes.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends nothing when an account is deleted", async () => {
    const tokens = await register("quiet-delete@example.com");

    const res = await request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("still sends the messages a person actually asked for", async () => {
    // The rule is "no notifications about business events", not "no email".
    await register("quiet-reset@example.com");

    const res = await request(app)
      .post("/api/v2/auth/password/forgot")
      .send({ email: "quiet-reset@example.com" });

    expect(res.status).toBeLessThan(500);
    expect(sendPasswordReset).toHaveBeenCalledTimes(1);
  });
});

describe("deleting an account with a live subscription", () => {
  const app = createApp();
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
  });

  it("stops the billing through the same guarded path and records it", async () => {
    // Deletion is not a kind of cancellation, but it must not leave PayPal
    // charging somebody who no longer has an account to sign in to.
    const tokens = (
      await request(app)
        .post("/api/v2/auth/register")
        .send({ email: "del-live@example.com", password: PASSWORD })
    ).body;
    const user = await User.findOne({ email_norm: "del-live@example.com" });
    const endsAt = new Date(Date.now() + 9 * DAY);

    let cancelled = false;
    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": (url) => {
        if (String(url).endsWith("/cancel")) {
          cancelled = true;
          return { status: 204, body: {} };
        }
        return cancelled
          ? { body: paypalSubscription({ id: "I-DELLIVE0001", status: "CANCELLED", billing_info: {} }) }
          : {
              body: paypalSubscription({
                id: "I-DELLIVE0001",
                custom_id: user.subject_id,
                status: "ACTIVE",
                billing_info: { next_billing_time: endsAt.toISOString() },
              }),
            };
      },
    });

    await request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-DELLIVE0001" });

    const res = await request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.paypal_subscription_cancelled).toBe(true);

    const record = await PaypalSubscription.findOne({ subscription_id: "I-DELLIVE0001" });
    expect(record.cancelled_at).toBeTruthy();
    // Distinguishable from an ordinary cancellation in the record, which is
    // what lets the weekly tally count deletions and cancellations separately.
    expect(record.cancellation_source).toBe("account_deletion");
    // Detached from the account, kept against the pseudonymous id.
    expect(record.user_id).toBeFalsy();

    const deleted = await User.findOne({ subject_id: user.subject_id });
    expect(deleted.status).toBe("deleted");

    // The entitlement is revoked outright: the account is gone, so there is
    // nobody left for the remaining paid days to belong to.
    const entitlement = await Entitlement.findOne({ subject_id: user.subject_id });
    expect(entitlement.status).toBe("revoked");
  });
});
