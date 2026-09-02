import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { Entitlement } from "../../src/models/entitlement";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { AuditLog } from "../../src/models/auditLog";
import { EntitlementAudit } from "../../src/models/entitlementAudit";
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

describeIfSsl("account and coexistence", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const grantApple = async (tokens, originalTransactionId) => {
    const transaction = appleTransaction({ originalTransactionId });
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
    process.env.V1_ENTITLEMENT_READONLY = "false";
  });

  describe("account deletion", () => {
    it("requires the password again", async () => {
      const tokens = await register("del-nopw@example.com");

      const res = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({});

      expect(res.status).toBe(401);
    });

    it("rejects a wrong password", async () => {
      const tokens = await register("del-wrongpw@example.com");

      const res = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ password: "not-the-password" });

      expect(res.status).toBe(401);
    });

    it("tombstones the account and ends every session", async () => {
      const tokens = await register("del-ok@example.com");

      const res = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ password: PASSWORD });

      expect(res.status).toBe(200);

      const user = await User.findOne({ subject_id: { $exists: true }, status: "deleted" });
      expect(user.email).toMatch(/^deleted\+[0-9a-f]+@deleted\.invalid$/);
      expect(user.deleted_at).toBeTruthy();

      // The access token stops working immediately, not at expiry.
      const after = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(after.status).toBe(401);

      const refresh = await request(app)
        .post("/api/v2/auth/refresh")
        .send({ refresh_token: tokens.refresh_token });
      expect(refresh.status).toBe(401);
    });

    it("frees the address for re-registration", async () => {
      const tokens = await register("del-reuse@example.com");
      await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ password: PASSWORD });

      const again = await request(app)
        .post("/api/v2/auth/register")
        .send({ email: "del-reuse@example.com", password: PASSWORD });

      expect(again.status).toBe(201);
    });

    it("tells the user an Apple subscription still needs cancelling", async () => {
      // Apple manages its own billing. Deleting the account does not stop it,
      // and the app has to say so or Apple rejects the submission.
      const tokens = await register("del-apple@example.com");
      await grantApple(tokens, "4000000000000001");

      const res = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.apple_subscription_requires_manual_cancellation).toBe(true);
    });

    it("cancels a linked PayPal subscription", async () => {
      const tokens = await register("del-paypal@example.com");

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) =>
          String(url).endsWith("/cancel")
            ? { status: 204, body: {} }
            : { body: paypalSubscription({ id: "I-DELETEME001" }) },
      });

      await request(app)
        .post("/api/v2/entitlements/paypal/link")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ subscription_id: "I-DELETEME001" });

      const res = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.paypal_subscription_cancelled).toBe(true);
    });

    it("keeps financial records against the pseudonymous id, detached from the account", async () => {
      const tokens = await register("del-records@example.com");
      const grant = await grantApple(tokens, "4000000000000002");

      const before = await User.findOne({ email_norm: "del-records@example.com" });
      const subjectId = before.subject_id;

      const del = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ password: PASSWORD });
      expect(del.status).toBe(200);

      const entitlement = await Entitlement.findOne({ subject_id: subjectId });
      expect(entitlement).toBeTruthy();
      expect(entitlement.user_id).toBeUndefined();
      expect(entitlement.status).toBe("revoked");

      const audit = await AuditLog.findOne({ action: "account.delete", subject_id: subjectId });
      expect(audit).toBeTruthy();
  });

    it("lets a second account with the same platform be deleted too", async () => {
      // Regression: the unique index on { user_id, platform } once caught
      // detached records as well, so the second deletion collided on
      // { user_id: null, platform: "apple" } and failed with a 500.
      const first = await register("del-collide-1@example.com");
      await grantApple(first, "4100000000000001");
      const firstDelete = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${first.access_token}`)
        .send({ password: PASSWORD });
      expect(firstDelete.status).toBe(200);

      const second = await register("del-collide-2@example.com");
      await grantApple(second, "4100000000000002");
      const secondDelete = await request(app)
        .delete("/api/v2/me")
        .set("Authorization", `Bearer ${second.access_token}`)
        .send({ password: PASSWORD });

      expect(secondDelete.status).toBe(200);
    });
  });

  describe("idempotency", () => {
    it("replays the stored response for a repeated key", async () => {
      const tokens = await register("idem-1@example.com");
      const transaction = appleTransaction({ originalTransactionId: "5000000000000001" });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      // Signed once: ECDSA signatures are randomized, so re-signing would
      // produce a different body and be correctly refused as key reuse.
      const signed = signApple(transaction);

      const send = () =>
        request(app)
          .post("/api/v2/entitlements/apple/verify")
          .set("Authorization", `Bearer ${tokens.access_token}`)
          .set("Idempotency-Key", "key-abc")
          .send({ signed_transaction: signed });

      const first = await send();
      const second = await send();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.headers["idempotent-replay"]).toBe("true");
      expect(second.body).toEqual(first.body);
    });

    it("refuses a key reused for a different request", async () => {
      const tokens = await register("idem-2@example.com");
      const one = appleTransaction({ originalTransactionId: "5000000000000002" });
      const two = appleTransaction({ originalTransactionId: "5000000000000003" });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(one) },
      });

      await request(app)
        .post("/api/v2/entitlements/apple/verify")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .set("Idempotency-Key", "key-shared")
        .send({ signed_transaction: signApple(one) });

      const res = await request(app)
        .post("/api/v2/entitlements/apple/verify")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .set("Idempotency-Key", "key-shared")
        .send({ signed_transaction: signApple(two) });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("idempotency_key_reused");
    });

    it("scopes keys per account", async () => {
      const a = await register("idem-a@example.com");
      const b = await register("idem-b@example.com");
      const transaction = appleTransaction({ originalTransactionId: "5000000000000004" });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      const first = await request(app)
        .post("/api/v2/entitlements/apple/verify")
        .set("Authorization", `Bearer ${a.access_token}`)
        .set("Idempotency-Key", "same-key")
        .send({ signed_transaction: signApple(transaction) });
      expect(first.status).toBe(200);

      // Same key, different account: not a replay, so it is processed and
      // then refused on its own merits.
      const second = await request(app)
        .post("/api/v2/entitlements/apple/verify")
        .set("Authorization", `Bearer ${b.access_token}`)
        .set("Idempotency-Key", "same-key")
        .send({ signed_transaction: signApple(transaction) });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe("transaction_already_linked");
    });
  });

  describe("v1 and v2 coexistence", () => {
    it("lets an account created on v1 sign in on v2", async () => {
      await request(app).post("/api/user/register").send({
        email: "coexist-v1@example.com",
        password: PASSWORD,
        terms_accepted: "false",
      });

      const res = await request(app)
        .post("/api/v2/auth/login")
        .send({ email: "coexist-v1@example.com", password: PASSWORD });

      expect(res.status).toBe(200);
    });

    it("shows a v2 entitlement to a v1 client through subscription_date", async () => {
      const tokens = await register("coexist-both@example.com");
      await grantApple(tokens, "6000000000000001");

      const v1 = await request(app).get("/api/user/coexist-both%40example.com");

      expect(v1.status).toBe(200);
      expect(v1.body.user.subscription_date).not.toBe("");
      expect(Number.isNaN(Date.parse(v1.body.user.subscription_date))).toBe(false);
    });

    it("ignores a v1 entitlement write once the account has a server-owned one", async () => {
      process.env.V1_ENTITLEMENT_READONLY = "true";

      const tokens = await register("coexist-locked@example.com");
      await grantApple(tokens, "6000000000000002");

      const before = await User.findOne({ email_norm: "coexist-locked@example.com" });

      const res = await request(app).patch("/api/user/update").send({
        email: "coexist-locked@example.com",
        subscription_date: "01/01/2099 00:00:00",
        terms_accepted: null,
      });

      // Still reports success, so released clients are unaffected.
      expect(res.status).toBe(200);

      const after = await User.findOne({ email_norm: "coexist-locked@example.com" });
      expect(after.subscription_date).toBe(before.subscription_date);
      expect(after.subscription_date).not.toBe("01/01/2099 00:00:00");

      const audit = await EntitlementAudit.findOne({
        email_norm: "coexist-locked@example.com",
      });
      expect(audit.ignored).toBe(true);
    });

    it("still honours a v1 write for an account with no server-owned entitlement", async () => {
      process.env.V1_ENTITLEMENT_READONLY = "true";

      await request(app).post("/api/user/register").send({
        email: "coexist-legacy@example.com",
        password: PASSWORD,
        terms_accepted: "false",
      });

      const res = await request(app).patch("/api/user/update").send({
        email: "coexist-legacy@example.com",
        subscription_date: "03/03/2026 09:00:00",
        terms_accepted: null,
      });

      expect(res.status).toBe(200);
      expect(res.body.user.subscription_date).toBe("03/03/2026 09:00:00");
    });
  });
});
