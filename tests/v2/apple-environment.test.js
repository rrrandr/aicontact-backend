import request from "supertest";
import { createApp } from "../../src/app";
import { Entitlement } from "../../src/models/entitlement";
import {
  signApple,
  appleTransaction,
  appleStatusResponse,
  appleMultiStatusResponse,
  installFetchStub,
} from "../helpers/providers";
import { appleCerts, opensslAvailable } from "../helpers/appleCerts";

const describeIfSsl = opensslAvailable() ? describe : describe.skip;
const PASSWORD = "a-sufficiently-long-password";

describeIfSsl("Apple environment and product safety", () => {
  const app = createApp();
  const realFetch = global.fetch;

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  const verify = (tokens, transaction) =>
    request(app)
      .post("/api/v2/entitlements/apple/verify")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ signed_transaction: signApple(transaction) });

  beforeAll(() => {
    process.env.APPLE_ROOT_CERTS = appleCerts().trusted.rootDer;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.APPLE_ENVIRONMENT = "Production";
    process.env.APPLE_ALLOW_SANDBOX = "false";
    process.env.APPLE_PRODUCT_IDS = "";
  });

  describe("sandbox purchases must not unlock production", () => {
    it("refuses a sandbox subscription when running in production", async () => {
      // A TestFlight or sandbox purchase costs nothing. If production falls
      // back to Apple's sandbox API and treats the result as a real
      // entitlement, the service is free to anyone who can build the app.
      const tokens = await register("apple-env-sandbox@example.com");
      const transaction = appleTransaction({ originalTransactionId: "7000000000000001" });

      installFetchStub({
        "api.storekit.itunes.apple.com": { status: 404, body: {} },
        "api.storekit-sandbox.itunes.apple.com": {
          body: appleStatusResponse(transaction, { environment: "Sandbox" }),
        },
      });

      const res = await verify(tokens, transaction);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("apple_environment_rejected");

      const rows = await Entitlement.find({ platform: "apple" });
      expect(rows.every((row) => row.status !== "active" || row.environment !== "Sandbox")).toBe(true);
    });

    it("refuses a production-labelled response that actually came from sandbox", async () => {
      const tokens = await register("apple-env-mislabel@example.com");
      const transaction = appleTransaction({ originalTransactionId: "7000000000000002" });

      installFetchStub({
        "api.storekit.itunes.apple.com": { status: 404, body: {} },
        "api.storekit-sandbox.itunes.apple.com": {
          // Sandbox host, but the body claims Production.
          body: appleStatusResponse(transaction, { environment: "Production" }),
        },
      });

      const res = await verify(tokens, transaction);
      expect(res.status).toBe(400);
    });

    it("accepts a sandbox subscription when sandbox is explicitly allowed", async () => {
      process.env.APPLE_ALLOW_SANDBOX = "true";

      const tokens = await register("apple-env-allowed@example.com");
      const transaction = appleTransaction({ originalTransactionId: "7000000000000003" });

      installFetchStub({
        "api.storekit.itunes.apple.com": { status: 404, body: {} },
        "api.storekit-sandbox.itunes.apple.com": {
          body: appleStatusResponse(transaction, { environment: "Sandbox" }),
        },
      });

      const res = await verify(tokens, transaction);

      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(true);
      expect(res.body.entitlement.environment).toBe("Sandbox");
    });

    it("does not count a stored sandbox entitlement as active in production", async () => {
      // Belt and braces: even a row written before this policy existed must
      // not grant access once production stops accepting sandbox.
      const tokens = await register("apple-env-stored@example.com");
      process.env.APPLE_ALLOW_SANDBOX = "true";

      const transaction = appleTransaction({ originalTransactionId: "7000000000000004" });
      installFetchStub({
        "api.storekit.itunes.apple.com": { status: 404, body: {} },
        "api.storekit-sandbox.itunes.apple.com": {
          body: appleStatusResponse(transaction, { environment: "Sandbox" }),
        },
      });
      await verify(tokens, transaction);

      process.env.APPLE_ALLOW_SANDBOX = "false";

      const res = await request(app)
        .get("/api/v2/entitlements")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(res.body.entitlement.active).toBe(false);
    });
  });

  describe("product allowlist", () => {
    it("refuses a product we do not sell", async () => {
      process.env.APPLE_PRODUCT_IDS = "com.facestream.aicontact.monthly";

      const tokens = await register("apple-product-bad@example.com");
      const transaction = appleTransaction({
        originalTransactionId: "7100000000000001",
        productId: "com.facestream.somethingelse",
      });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      const res = await verify(tokens, transaction);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("apple_unknown_product");
    });

    it("accepts a product on the allowlist", async () => {
      process.env.APPLE_PRODUCT_IDS = "com.facestream.aicontact.monthly";

      const tokens = await register("apple-product-good@example.com");
      const transaction = appleTransaction({ originalTransactionId: "7100000000000002" });

      installFetchStub({
        "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
      });

      const res = await verify(tokens, transaction);
      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(true);
    });
  });

  describe("transaction selection", () => {
    it("selects the transaction matching the requested original id", async () => {
      // Apple returns every subscription in the group. Taking the first one
      // reads somebody else's subscription state onto this purchase.
      const tokens = await register("apple-select@example.com");

      const wanted = appleTransaction({
        originalTransactionId: "7200000000000002",
        expiresDate: Date.now() + 40 * 24 * 60 * 60 * 1000,
      });
      const other = appleTransaction({
        originalTransactionId: "7200000000000001",
        expiresDate: Date.now() - 24 * 60 * 60 * 1000,
      });

      installFetchStub({
        "/inApps/v1/subscriptions/": {
          body: appleMultiStatusResponse([
            [{ transaction: other, status: 2 }],
            [{ transaction: wanted, status: 1 }],
          ]),
        },
      });

      const res = await verify(tokens, wanted);

      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(true);
      expect(res.body.entitlement.days_remaining).toBeGreaterThan(35);
    });

    it("refuses when the response contains no matching transaction", async () => {
      const tokens = await register("apple-select-missing@example.com");

      const wanted = appleTransaction({ originalTransactionId: "7300000000000001" });
      const unrelated = appleTransaction({ originalTransactionId: "7300000000000099" });

      installFetchStub({
        "/inApps/v1/subscriptions/": {
          body: appleMultiStatusResponse([[{ transaction: unrelated }]]),
        },
      });

      const res = await verify(tokens, wanted);
      expect([400, 404]).toContain(res.status);
      expect(res.body.entitlement).toBeUndefined();
    });
  });
});
