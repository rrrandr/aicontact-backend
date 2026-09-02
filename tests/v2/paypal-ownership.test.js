import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import {
  paypalSubscription,
  installFetchStub,
  paypalAuthRoute,
} from "../helpers/providers";

const PASSWORD = "a-sufficiently-long-password";

describe("PayPal subscription ownership", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const link = (tokens, subscriptionId) =>
    request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: subscriptionId });

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
    process.env.PAYPAL_LEGACY_CLAIM_ENABLED = "false";
  });

  describe("a subscription id alone proves nothing", () => {
    it("refuses to link a subscription that carries no account binding", async () => {
      // Subscription IDs appear in customer emails, receipts and PayPal's own
      // UI. Whoever presents one first must not become its owner.
      const attacker = await register("pp-own-attacker@example.com");

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-VICTIMSUB01" }),
        },
      });

      const res = await link(attacker, "I-VICTIMSUB01");

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("paypal_ownership_unverified");
      expect(await PaypalSubscription.findOne({ subscription_id: "I-VICTIMSUB01" })).toBeNull();
    });

    it("refuses a subscription bound to a different account", async () => {
      const owner = await register("pp-own-real@example.com");
      const attacker = await register("pp-own-thief@example.com");

      const ownerUser = await User.findOne({ email_norm: "pp-own-real@example.com" });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({ id: "I-BOUNDSUB001", custom_id: ownerUser.subject_id }),
        },
      });

      const stolen = await link(attacker, "I-BOUNDSUB001");
      expect(stolen.status).toBe(403);

      const legitimate = await link(owner, "I-BOUNDSUB001");
      expect(legitimate.status).toBe(200);
      expect(legitimate.body.entitlement.active).toBe(true);
    });
  });

  describe("server-created subscriptions", () => {
    it("creates a subscription bound to the authenticated account", async () => {
      const tokens = await register("pp-create@example.com");
      const user = await User.findOne({ email_norm: "pp-create@example.com" });

      let createdBody = null;
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions": (url, options) => {
          createdBody = JSON.parse(options.body);
          return {
            status: 201,
            body: {
              id: "I-SERVERMADE1",
              status: "APPROVAL_PENDING",
              links: [{ rel: "approve", href: "https://paypal.com/approve/I-SERVERMADE1" }],
            },
          };
        },
      });

      const res = await request(app)
        .post("/api/v2/entitlements/paypal/subscription")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ plan_id: "P-TEST-PLAN-1" });

      expect(res.status).toBe(201);
      expect(res.body.approve_url).toContain("paypal.com/approve");
      // The binding is set by us, from the session - never from the request.
      expect(createdBody.custom_id).toBe(user.subject_id);
    });

    it("refuses to create a subscription for a plan we do not sell", async () => {
      const tokens = await register("pp-create-badplan@example.com");

      installFetchStub({ ...paypalAuthRoute });

      const res = await request(app)
        .post("/api/v2/entitlements/paypal/subscription")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ plan_id: "P-NOT-OURS" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("paypal_unknown_plan");
    });
  });

  describe("legacy claim, for subscriptions created before binding existed", () => {
    it("is refused while the migration path is disabled", async () => {
      const tokens = await register("pp-legacy-off@example.com");

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": { body: paypalSubscription({ id: "I-LEGACY00001" }) },
      });

      const res = await request(app)
        .post("/api/v2/entitlements/paypal/claim-legacy/start")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-LEGACY00001" });

      expect(res.status).toBe(403);
    });

    it("proves ownership with a code sent to the PayPal account's own address", async () => {
      process.env.PAYPAL_LEGACY_CLAIM_ENABLED = "true";
      const tokens = await register("pp-legacy-ok@example.com");

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-LEGACY00002",
            subscriber: { email_address: "payer@example.com" },
          }),
        },
      });

      const start = await request(app)
        .post("/api/v2/entitlements/paypal/claim-legacy/start")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-LEGACY00002" });

      expect(start.status).toBe(202);
      // The address is PayPal's, never one the caller supplied.
      expect(start.body.sent_to).toContain("***");
      expect(start.body.code).toBeUndefined();

      const wrong = await request(app)
        .post("/api/v2/entitlements/paypal/claim-legacy/confirm")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-LEGACY00002", code: "000000" });

      expect(wrong.status).toBe(400);
      expect(await PaypalSubscription.findOne({ subscription_id: "I-LEGACY00002" })).toBeNull();
    });

    it("refuses to legacy-claim a subscription that already carries a binding", async () => {
      process.env.PAYPAL_LEGACY_CLAIM_ENABLED = "true";
      const tokens = await register("pp-legacy-bound@example.com");

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-LEGACY00003",
            custom_id: "sub_someone_else",
            subscriber: { email_address: "payer@example.com" },
          }),
        },
      });

      const res = await request(app)
        .post("/api/v2/entitlements/paypal/claim-legacy/start")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-LEGACY00003" });

      expect(res.status).toBe(403);
    });
  });
});
