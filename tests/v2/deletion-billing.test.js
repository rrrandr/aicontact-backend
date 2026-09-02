import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { PendingCancellation } from "../../src/models/pendingCancellation";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { paypalSubscription, installFetchStub, paypalAuthRoute } from "../helpers/providers";

const PASSWORD = "a-sufficiently-long-password";

describe("account deletion must not leave billing running", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const linkSubscription = async (tokens, email, subscriptionId, cancelBehaviour) => {
    const user = await User.findOne({ email_norm: email });
    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": (url) =>
        String(url).endsWith("/cancel")
          ? cancelBehaviour()
          : {
              body: paypalSubscription({
                id: subscriptionId,
                custom_id: user.subject_id,
                status: cancelBehaviour.currentStatus ? cancelBehaviour.currentStatus() : "ACTIVE",
              }),
            },
    });

    const res = await request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: subscriptionId });
    expect(res.status).toBe(200);
    return user;
  };

  const deleteAccount = (tokens) =>
    request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ password: PASSWORD });

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
  });

  it("refuses to complete deletion when cancellation cannot be confirmed", async () => {
    // Detaching the person while PayPal keeps charging them is the worst
    // possible outcome: they can no longer sign in to stop it.
    const tokens = await register("delbill-fail@example.com");

    const behaviour = () => ({ status: 500, body: {} });
    behaviour.currentStatus = () => "ACTIVE";
    await linkSubscription(tokens, "delbill-fail@example.com", "I-DELFAIL0001", behaviour);

    const res = await deleteAccount(tokens);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("cancellation_unconfirmed");

    const user = await User.findOne({ email_norm: "delbill-fail@example.com" });
    expect(user.status).toBe("active");
    expect(user.deleted_at).toBeFalsy();
  });

  it("records a durable job so the cancellation can be retried", async () => {
    const tokens = await register("delbill-job@example.com");

    const behaviour = () => ({ status: 500, body: {} });
    behaviour.currentStatus = () => "ACTIVE";
    await linkSubscription(tokens, "delbill-job@example.com", "I-DELJOB00001", behaviour);

    await deleteAccount(tokens);

    const job = await PendingCancellation.findOne({ subscription_id: "I-DELJOB00001" });
    expect(job).toBeTruthy();
    expect(job.resolved_at).toBeFalsy();
    expect(job.attempts).toBeGreaterThan(0);
  });

  it("does not treat every 422 as a successful cancellation", async () => {
    // PayPal returns 422 for several conditions, only one of which is
    // "already inactive". Reading them all as success silently strands
    // a live subscription.
    const tokens = await register("delbill-422@example.com");

    const behaviour = () => ({
      status: 422,
      body: { details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] },
    });
    behaviour.currentStatus = () => "ACTIVE";
    await linkSubscription(tokens, "delbill-422@example.com", "I-DEL42200001", behaviour);

    const res = await deleteAccount(tokens);

    expect(res.status).toBe(503);
    const user = await User.findOne({ email_norm: "delbill-422@example.com" });
    expect(user.status).toBe("active");
  });

  it("completes when PayPal confirms the subscription is no longer active", async () => {
    const tokens = await register("delbill-ok@example.com");

    let cancelled = false;
    const behaviour = () => {
      cancelled = true;
      return { status: 204, body: {} };
    };
    behaviour.currentStatus = () => (cancelled ? "CANCELLED" : "ACTIVE");
    const before = await linkSubscription(
      tokens,
      "delbill-ok@example.com",
      "I-DELOK000001",
      behaviour
    );

    const res = await deleteAccount(tokens);

    expect(res.status).toBe(200);
    expect(res.body.paypal_subscription_cancelled).toBe(true);

    // The address is tombstoned on deletion, so the account is found by its
    // pseudonymous identifier.
    const user = await User.findOne({ subject_id: before.subject_id });
    expect(user.status).toBe("deleted");
    expect(user.email).toMatch(/@deleted\.invalid$/);
  });

  it("completes when the subscription was already inactive", async () => {
    const tokens = await register("delbill-already@example.com");

    const behaviour = () => ({
      status: 422,
      body: { details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] },
    });
    behaviour.currentStatus = () => "CANCELLED";

    const user = await User.findOne({ email_norm: "delbill-already@example.com" });
    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": (url) =>
        String(url).endsWith("/cancel")
          ? behaviour()
          : {
              body: paypalSubscription({
                id: "I-DELALREADY1",
                custom_id: user.subject_id,
                status: "ACTIVE",
              }),
            },
    });
    await request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-DELALREADY1" });

    // By deletion time PayPal reports it as already cancelled.
    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": (url) =>
        String(url).endsWith("/cancel")
          ? behaviour()
          : {
              body: paypalSubscription({
                id: "I-DELALREADY1",
                custom_id: user.subject_id,
                status: "CANCELLED",
              }),
            },
    });

    const res = await deleteAccount(tokens);
    expect(res.status).toBe(200);
  });

  it("deletes normally when there is no PayPal subscription at all", async () => {
    const tokens = await register("delbill-none@example.com");
    const res = await deleteAccount(tokens);
    expect(res.status).toBe(200);
  });
});
