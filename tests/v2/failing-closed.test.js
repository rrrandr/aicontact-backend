import request from "supertest";
import { createApp } from "../../src/app";
import { assertV2Config } from "../../src/config/env";
import {
  assertProductAllowed,
  AppleVerificationError,
} from "../../src/v2/services/appleService";
import {
  signApple,
  appleTransaction,
  appleStatusResponse,
  installFetchStub,
} from "../helpers/providers";
import { appleCerts, opensslAvailable } from "../helpers/appleCerts";

const describeIfSsl = opensslAvailable() ? describe : describe.skip;
const PASSWORD = "a-sufficiently-long-password";

describe("Apple product allowlist fails closed", () => {
  const original = process.env.APPLE_PRODUCT_IDS;

  afterEach(() => {
    process.env.APPLE_PRODUCT_IDS = original;
  });

  it("rejects every product when the allowlist is empty", () => {
    // An empty list previously meant "allow anything", so a missing or
    // mistyped production setting silently disabled the control.
    process.env.APPLE_PRODUCT_IDS = "";

    expect(() => assertProductAllowed("com.facestream.aicontact.monthly")).toThrow(
      AppleVerificationError
    );
    expect(() => assertProductAllowed("anything.at.all")).toThrow(/not configured|not one we sell/);
  });

  it("refuses to boot with v2 enabled and no allowlist", () => {
    process.env.APPLE_PRODUCT_IDS = "";
    expect(() => assertV2Config()).toThrow(/APPLE_PRODUCT_IDS/);
  });

  it("boots when the allowlist is populated", () => {
    process.env.APPLE_PRODUCT_IDS = "com.facestream.aicontact.monthly";
    expect(() => assertV2Config()).not.toThrow();
  });
});

describeIfSsl("an empty allowlist blocks entitlement at runtime", () => {
  const app = createApp();
  const realFetch = global.fetch;
  const original = process.env.APPLE_PRODUCT_IDS;

  beforeAll(() => {
    process.env.APPLE_ROOT_CERTS = appleCerts().trusted.rootDer;
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.APPLE_PRODUCT_IDS = original;
  });

  it("refuses a purchase rather than granting one", async () => {
    process.env.APPLE_PRODUCT_IDS = "";

    const tokens = (
      await request(app)
        .post("/api/v2/auth/register")
        .send({ email: "failclosed-apple@example.com", password: PASSWORD })
    ).body;

    const transaction = appleTransaction({ originalTransactionId: "B000000000000001" });
    installFetchStub({
      "/inApps/v1/subscriptions/": { body: appleStatusResponse(transaction) },
    });

    const res = await request(app)
      .post("/api/v2/entitlements/apple/verify")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ signed_transaction: signApple(transaction) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("apple_unknown_product");
  });
});
