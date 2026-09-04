// Runs before any test module is imported, so config getters see these.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
process.env.URI = process.env.URI || "mongodb://placeholder";

process.env.ENABLE_V2 = "true";
// Apple stays on for the suite so every existing Apple test keeps exercising
// the same validation and routes. tests/v2/apple-flag.test.js overrides it.
process.env.ENABLE_APPLE = "true";
process.env.JWT_ACCESS_SECRET =
  "test-access-secret-that-is-long-enough-to-pass-validation";
process.env.JWT_ACCESS_TTL = "15m";
process.env.REFRESH_TOKEN_TTL_DAYS = "60";
// Keep bcrypt cheap in tests; production uses the configured default.
process.env.BCRYPT_COST = "6";

// Ceilings raised so suites that create many accounts are not limited; the
// limiter itself is exercised in tests/v2/rate-limit.test.js.
// Just above the production default, so the v1 limiter test stays fast while
// no other suite trips it. The v2 ceilings are raised further because those
// suites create many accounts.
process.env.RATE_LIMIT_AUTH_MAX = "25";

// Backpressure delays are exercised properly in tests/unit/throttle.test.js
// with explicit options; here they only need to be non-zero.
process.env.THROTTLE_DELAY_MS = "1";
process.env.THROTTLE_MAX_DELAY_MS = "5";
process.env.RATE_LIMIT_V2_REGISTER = "10000";
process.env.RATE_LIMIT_V2_LOGIN = "10000";
process.env.RATE_LIMIT_V2_REFRESH = "10000";
process.env.RATE_LIMIT_V2_FORGOT = "10000";
process.env.RATE_LIMIT_V2_RESET = "10000";
process.env.RATE_LIMIT_V2_DELETE = "10000";
process.env.RATE_LIMIT_V2_ENTITLEMENT = "10000";

process.env.APPLE_ISSUER_ID = "test-issuer-id";
process.env.APPLE_KEY_ID = "TESTKEYID";
process.env.APPLE_BUNDLE_ID = "com.FaceStreamCorporation.AICONTACT";
process.env.APPLE_ENVIRONMENT = "Production";
// Required: an empty allowlist is a refusal, not a wildcard.
process.env.APPLE_PRODUCT_IDS = "com.facestream.aicontact.monthly";

// A throwaway P-256 key so App Store Server API tokens can actually be signed
// in tests. Generated per run; never a real Apple key.
const { generateKeyPairSync } = require("crypto");
process.env.APPLE_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

process.env.PAYPAL_CLIENT_ID = "test-client-id";
process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
process.env.PAYPAL_ENV = "sandbox";
process.env.PAYPAL_PLAN_IDS = "P-TEST-PLAN-1,P-TEST-PLAN-2";
process.env.PAYPAL_WEBHOOK_ID = "test-webhook-id";
