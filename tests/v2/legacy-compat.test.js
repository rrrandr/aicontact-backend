import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
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
const PASSWORD = "a-sufficiently-long-password";

/**
 * Released v1 clients compute access as
 *   remaining = 30 - (DateTime.Now - DateTime.Parse(subscription_date)).Days
 * and grant access while remaining > 0 (InAppPurchaseScreenHandler.cs:165-177).
 *
 * So subscription_date has to describe the CURRENT billing period, not when
 * the subscription was first taken out.
 */
// The stored format is MM/DD/YYYY HH:MM:SS in UTC, which is what the
// released client hands to DateTime.Parse.
const parseLegacy = (value) => {
  const [date, time] = value.split(" ");
  const [month, day, year] = date.split("/").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
};

const v1RemainingDays = (subscriptionDate) => {
  const started = parseLegacy(subscriptionDate);
  const elapsedDays = Math.floor((Date.now() - started.getTime()) / DAY);
  return 30 - elapsedDays;
};

describeIfSsl("v1 compatibility of the derived subscription_date", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  beforeAll(() => {
    process.env.APPLE_ROOT_CERTS = appleCerts().trusted.rootDer;
  });

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
  });

  it("keeps a long-standing PayPal subscriber visible to v1", async () => {
    // A subscriber who started two years ago and renews monthly. Deriving
    // subscription_date from the original start time makes v1 read them as
    // expired the instant they verify on v2.
    const tokens = await register("compat-pp-old@example.com");
    const user = await User.findOne({ email_norm: "compat-pp-old@example.com" });

    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": {
        body: paypalSubscription({
          id: "I-COMPATOLD1",
          custom_id: user.subject_id,
          start_time: new Date(Date.now() - 730 * DAY).toISOString(),
          billing_info: {
            next_billing_time: new Date(Date.now() + 20 * DAY).toISOString(),
          },
        }),
      },
    });

    const link = await request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: "I-COMPATOLD1" });
    expect(link.status).toBe(200);

    const v1 = await request(app).get("/api/user/compat-pp-old%40example.com");
    expect(v1.status).toBe(200);

    const remaining = v1RemainingDays(v1.body.user.subscription_date);
    expect(remaining).toBeGreaterThan(0);
    // Should track the real expiry, roughly 20 days out.
    expect(remaining).toBeGreaterThanOrEqual(19);
    expect(remaining).toBeLessThanOrEqual(31);
  });

  it("tracks the real expiry for an Apple subscriber", async () => {
    const tokens = await register("compat-apple@example.com");
    const transaction = appleTransaction({
      originalTransactionId: "A000000000000001",
      purchaseDate: Date.now() - 400 * DAY,
      expiresDate: Date.now() + 10 * DAY,
    });

    installFetchStub({
      "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
    });

    await request(app)
      .post("/api/v2/entitlements/apple/verify")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ signed_transaction: signApple(transaction) });

    const v1 = await request(app).get("/api/user/compat-apple%40example.com");
    const remaining = v1RemainingDays(v1.body.user.subscription_date);

    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeGreaterThanOrEqual(9);
    expect(remaining).toBeLessThanOrEqual(11);
  });

  it("never reports more than a v1 client can represent", async () => {
    // An annual subscription must not produce a future-dated value that a v1
    // client would read as an impossibly long window.
    const tokens = await register("compat-annual@example.com");
    const transaction = appleTransaction({
      originalTransactionId: "A000000000000002",
      expiresDate: Date.now() + 365 * DAY,
    });

    installFetchStub({
      "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
    });

    await request(app)
      .post("/api/v2/entitlements/apple/verify")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ signed_transaction: signApple(transaction) });

    const v1 = await request(app).get("/api/user/compat-annual%40example.com");
    const stored = parseLegacy(v1.body.user.subscription_date);

    expect(stored.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(v1RemainingDays(v1.body.user.subscription_date)).toBeGreaterThan(0);
  });

  it("clears the field when entitlement lapses", async () => {
    const tokens = await register("compat-expired@example.com");
    const transaction = appleTransaction({
      originalTransactionId: "A000000000000003",
      expiresDate: Date.now() - DAY,
    });

    installFetchStub({
      "/inApps/v1/subscriptions/": {
        body: appleStatusResponse(transaction, { status: 2 }),
      },
    });

    await request(app)
      .post("/api/v2/entitlements/apple/verify")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ signed_transaction: signApple(transaction) });

    const v1 = await request(app).get("/api/user/compat-expired%40example.com");
    expect(v1.body.user.subscription_date).toBe("");
  });

  it("produces a value the released client's parser accepts", async () => {
    const tokens = await register("compat-format@example.com");
    const transaction = appleTransaction({ originalTransactionId: "A000000000000004" });

    installFetchStub({
      "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
    });

    await request(app)
      .post("/api/v2/entitlements/apple/verify")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ signed_transaction: signApple(transaction) });

    const v1 = await request(app).get("/api/user/compat-format%40example.com");
    expect(v1.body.user.subscription_date).toMatch(
      /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/
    );
    expect(Number.isNaN(Date.parse(v1.body.user.subscription_date))).toBe(false);
  });
});
