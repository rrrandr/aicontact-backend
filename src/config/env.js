import dotenv from "dotenv";

dotenv.config();

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
};

// Required values are validated once, at boot, so a misconfigured deploy fails
// loudly on start instead of serving 500s for every request.
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
};

const required = (name) => {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    throw new Error(
      `Environment variable ${name} is required but was not set. See .env.example.`
    );
  }
  return raw.trim();
};

export const config = {
  env: process.env.NODE_ENV || "development",
  port: num("PORT", 5000),
  logLevel: process.env.LOG_LEVEL || "info",

  get mongoUri() {
    return required("URI");
  },

  rateLimit: {
    authWindowMs: num("RATE_LIMIT_AUTH_WINDOW_MS", 15 * 60 * 1000),
    authMax: num("RATE_LIMIT_AUTH_MAX", 20),

    // Per-endpoint v2 ceilings, tunable without a code change.
    v2: {
      register: num("RATE_LIMIT_V2_REGISTER", 10),
      login: num("RATE_LIMIT_V2_LOGIN", 20),
      refresh: num("RATE_LIMIT_V2_REFRESH", 60),
      forgot: num("RATE_LIMIT_V2_FORGOT", 5),
      reset: num("RATE_LIMIT_V2_RESET", 10),
      remove: num("RATE_LIMIT_V2_DELETE", 5),
      entitlement: num("RATE_LIMIT_V2_ENTITLEMENT", 30),
    },
  },

  // v2 configuration. Required values are only demanded when v2 is enabled,
  // so a v1-only deployment is unaffected by their absence.
  v2Enabled: bool("ENABLE_V2", false),
  // A getter so the rollout flag can be flipped without a code change and is
  // read at the moment of use.
  get v1EntitlementReadonly() {
    return bool("V1_ENTITLEMENT_READONLY", false);
  },

  auth: {
    get accessSecret() {
      return secret("JWT_ACCESS_SECRET");
    },
    accessTtl: process.env.JWT_ACCESS_TTL || "15m",
    refreshTtlDays: num("REFRESH_TOKEN_TTL_DAYS", 60),
    // How long after a rotation a second presentation of the same token is
    // read as a concurrent duplicate rather than a replay. See
    // rotateRefreshToken for why this does not weaken reuse detection.
    reuseGraceMs: num("REFRESH_REUSE_GRACE_MS", 10000),
    bcryptCost: num("BCRYPT_COST", 12),
  },

  apple: {
    get issuerId() { return required("APPLE_ISSUER_ID"); },
    get keyId() { return required("APPLE_KEY_ID"); },
    get privateKey() { return required("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n"); },
    get bundleId() { return required("APPLE_BUNDLE_ID"); },
    environment: process.env.APPLE_ENVIRONMENT || "Production",
    // Sandbox purchases cost nothing. Accepting them in production makes the
    // service free to anyone who can build the app, so this is opt-in and
    // read per request rather than fixed at boot.
    get allowSandbox() {
      return bool("APPLE_ALLOW_SANDBOX", false);
    },
    get productIds() {
      return (process.env.APPLE_PRODUCT_IDS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    },
    get rootCerts() {
      const raw = process.env.APPLE_ROOT_CERTS || "";
      return raw.split(",").map((v) => v.trim()).filter(Boolean);
    },
  },

  paypal: {
    get clientId() { return required("PAYPAL_CLIENT_ID"); },
    get clientSecret() { return required("PAYPAL_CLIENT_SECRET"); },
    env: process.env.PAYPAL_ENV || "live",
    get planIds() {
      return (process.env.PAYPAL_PLAN_IDS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    },
    get webhookId() { return required("PAYPAL_WEBHOOK_ID"); },

    // Off by default. Only for a supervised migration of subscriptions that
    // pre-date server-side binding; see README.
    get legacyClaimEnabled() {
      return bool("PAYPAL_LEGACY_CLAIM_ENABLED", false);
    },
    returnUrl: process.env.PAYPAL_RETURN_URL || "",
    cancelUrl: process.env.PAYPAL_CANCEL_URL || "",
  },

  mail: {
    provider: process.env.MAIL_PROVIDER || "log",
    apiKey: process.env.MAIL_PROVIDER_KEY || "",
    from: process.env.MAIL_FROM || "no-reply@example.invalid",
    resetUrlBase: process.env.PASSWORD_RESET_URL_BASE || "",
  },

  // Read per request rather than at boot, so the payload served to clients
  // reflects the current environment.
  publicConfig: {
    get apiBaseUrl() {
      return process.env.PUBLIC_API_BASE_URL || "";
    },
    get minClientVersion() {
      return process.env.MIN_CLIENT_VERSION || "0.0.0";
    },
    get forceUpgrade() {
      return bool("FORCE_UPGRADE", false);
    },
    get message() {
      return process.env.CONFIG_MESSAGE || "";
    },
    get signingKey() {
      return process.env.CONFIG_SIGNING_KEY || "";
    },
  },

  cors: {
    // v2 only. v1 stays permissive for the released native clients.
    get allowedOrigins() {
      return (process.env.CORS_ALLOWED_ORIGINS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    },
  },

  bodyLimits: {
    default: process.env.BODY_LIMIT_DEFAULT || "100kb",
    // Signed Apple transactions and provider notifications are legitimately
    // larger than an ordinary request.
    webhook: process.env.BODY_LIMIT_WEBHOOK || "1mb",
    entitlement: process.env.BODY_LIMIT_ENTITLEMENT || "256kb",
  },

  // Read per call so the enforcement job picks up a change without a
  // redeploy. These defaults are placeholders pending legal sign-off.
  retention: {
    get financialRecordDays() {
      return num("RETENTION_FINANCIAL_DAYS", 2555);
    },
    get auditLogDays() {
      return num("RETENTION_AUDIT_DAYS", 365);
    },
  },

  throttle: {
    after: num("THROTTLE_AFTER", 60),
    delayMs: num("THROTTLE_DELAY_MS", 250),
    maxDelayMs: num("THROTTLE_MAX_DELAY_MS", 4000),
    windowMs: num("THROTTLE_WINDOW_MS", 60 * 1000),
    hardMax: num("THROTTLE_HARD_MAX", 1200),
  },
};

// Secrets get a stricter check than ordinary required values. The dead
// verifyJwt.js this replaces signed tokens with the literal string "secret";
// making that shape impossible is worth more than fixing the one instance.
const PLACEHOLDERS = new Set([
  "secret",
  "changeme",
  "change-me",
  "your-secret-here",
  "todo",
  "password",
]);

function secret(name) {
  const value = required(name);
  if (value.length < 32) {
    throw new Error(
      `Environment variable ${name} must be at least 32 characters; got ${value.length}.`
    );
  }
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new Error(`Environment variable ${name} is set to a placeholder value.`);
  }
  return value;
}

/**
 * Touches every value v2 needs so a misconfigured deployment fails at boot
 * rather than at the first purchase. Called from index.js when v2 is enabled.
 */
export const assertV2Config = () => {
  const checks = [
    () => config.auth.accessSecret,
    () => config.apple.issuerId,
    () => config.apple.keyId,
    () => config.apple.privateKey,
    () => config.apple.bundleId,
    () => config.paypal.clientId,
    () => config.paypal.clientSecret,
    () => config.paypal.webhookId,
  ];
  for (const check of checks) check();

  if (!config.paypal.planIds.length) {
    throw new Error(
      "PAYPAL_PLAN_IDS must list at least one plan; without it any PayPal subscription would be accepted."
    );
  }

  if (!config.apple.productIds.length) {
    throw new Error(
      "APPLE_PRODUCT_IDS must list at least one product; without it any in-app purchase under the bundle would grant entitlement."
    );
  }
};

export const isProduction = () => config.env === "production";
