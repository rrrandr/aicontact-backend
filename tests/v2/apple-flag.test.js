import request from "supertest";

/**
 * ENABLE_APPLE gates whether this deployment carries Apple at all.
 *
 * A PayPal-only install should not have to hold Apple credentials it will never
 * use, and supplying placeholder values to satisfy a check would hide a real
 * misconfiguration behind a passing boot. With the flag off, the Apple
 * credentials are not demanded and the Apple routes are not mounted.
 *
 * Both `config.appleEnabled` and the router are resolved when their module is
 * first loaded, so each case is exercised in an isolated module registry.
 */

const APPLE_KEYS = [
  "APPLE_ISSUER_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_BUNDLE_ID",
  "APPLE_PRODUCT_IDS",
];

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.resetModules();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
  }
};

const stripApple = () =>
  Object.fromEntries(APPLE_KEYS.map((k) => [k, undefined]));

describe("assertV2Config with ENABLE_APPLE=false", () => {
  it("boots a PayPal-only deployment with no Apple configuration at all", () => {
    withEnv({ ENABLE_APPLE: "false", ...stripApple() }, () => {
      const { assertV2Config } = require("../../src/config/env");
      expect(() => assertV2Config()).not.toThrow();
    });
  });

  it("still refuses to start when PayPal configuration is incomplete", () => {
    withEnv(
      { ENABLE_APPLE: "false", ...stripApple(), PAYPAL_CLIENT_ID: "" },
      () => {
        const { assertV2Config } = require("../../src/config/env");
        expect(() => assertV2Config()).toThrow(/PAYPAL_CLIENT_ID/);
      }
    );
  });

  it("still refuses an empty PayPal plan allowlist", () => {
    withEnv(
      { ENABLE_APPLE: "false", ...stripApple(), PAYPAL_PLAN_IDS: "" },
      () => {
        const { assertV2Config } = require("../../src/config/env");
        expect(() => assertV2Config()).toThrow(/PAYPAL_PLAN_IDS/);
      }
    );
  });
});

describe("assertV2Config with ENABLE_APPLE=true", () => {
  it("demands Apple credentials exactly as before", () => {
    withEnv({ ENABLE_APPLE: "true", APPLE_ISSUER_ID: "" }, () => {
      const { assertV2Config } = require("../../src/config/env");
      expect(() => assertV2Config()).toThrow(/APPLE_ISSUER_ID/);
    });
  });

  it("still rejects an empty product allowlist, which would grant entitlement to any purchase", () => {
    withEnv({ ENABLE_APPLE: "true", APPLE_PRODUCT_IDS: "" }, () => {
      const { assertV2Config } = require("../../src/config/env");
      expect(() => assertV2Config()).toThrow(/APPLE_PRODUCT_IDS/);
    });
  });

  it("accepts a fully configured deployment", () => {
    withEnv({ ENABLE_APPLE: "true" }, () => {
      const { assertV2Config } = require("../../src/config/env");
      expect(() => assertV2Config()).not.toThrow();
    });
  });
});

describe("route mounting follows the flag", () => {
  // 404 means the route does not exist. 401/400 means it exists and rejected
  // this particular unauthenticated or unsigned request, which is the point:
  // the two cases must not be confused with one another.
  const buildApp = () => {
    const { createApp } = require("../../src/app");
    return createApp();
  };

  it("does not mount Apple verification or the Apple webhook when disabled", async () => {
    await withEnv({ ENABLE_APPLE: "false", ...stripApple() }, async () => {
      const app = buildApp();

      const verify = await request(app)
        .post("/api/v2/entitlements/apple/verify")
        .send({});
      expect(verify.status).toBe(404);

      const hook = await request(app).post("/api/v2/webhooks/apple").send({});
      expect(hook.status).toBe(404);
    });
  });

  it("keeps the PayPal webhook mounted when Apple is disabled", async () => {
    await withEnv({ ENABLE_APPLE: "false", ...stripApple() }, async () => {
      const app = buildApp();
      const hook = await request(app).post("/api/v2/webhooks/paypal").send({});
      expect(hook.status).not.toBe(404);
    });
  });

  it("keeps PayPal entitlement routes mounted when Apple is disabled", async () => {
    await withEnv({ ENABLE_APPLE: "false", ...stripApple() }, async () => {
      const app = buildApp();
      const link = await request(app)
        .post("/api/v2/entitlements/paypal/link")
        .send({});
      // Mounted, and refusing because there is no bearer token.
      expect(link.status).toBe(401);
    });
  });

  it("mounts Apple routes when enabled", async () => {
    await withEnv({ ENABLE_APPLE: "true" }, async () => {
      const app = buildApp();

      const verify = await request(app)
        .post("/api/v2/entitlements/apple/verify")
        .send({});
      expect(verify.status).toBe(401);

      const hook = await request(app).post("/api/v2/webhooks/apple").send({});
      expect(hook.status).not.toBe(404);
    });
  });
});
