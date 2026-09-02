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
  },

  throttle: {
    after: num("THROTTLE_AFTER", 60),
    delayMs: num("THROTTLE_DELAY_MS", 250),
    maxDelayMs: num("THROTTLE_MAX_DELAY_MS", 4000),
    windowMs: num("THROTTLE_WINDOW_MS", 60 * 1000),
    hardMax: num("THROTTLE_HARD_MAX", 1200),
  },
};

export const isProduction = () => config.env === "production";
