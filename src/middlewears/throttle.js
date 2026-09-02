import { config } from "../config/env";
import { logger } from "../util/logger";

/**
 * Delay-based throttle for the endpoints that released clients retry.
 *
 * WHY THIS IS NOT A RATE LIMITER
 * ------------------------------
 * Three completion handlers in the shipped Unity client re-issue their request
 * immediately when it fails, with no backoff and no attempt cap:
 *
 *   InAppPurchaseScreenHandler.cs:159-162   GetUser    -> GetUser
 *   InAppPurchaseScreenHandler.cs:315-318   UpdateUser -> UpdateUser
 *   TermsAndConditionsScreenHandler.cs:104-107  UpdateUser -> UpdateUser
 *
 * UnityWebRequest.Result classifies every 4xx and 5xx as a failure, so
 * answering these endpoints with 429 would put every installed app into a hot
 * loop against this server. Slowing the response instead applies real
 * backpressure without ever entering the client's retry branch.
 *
 * A hard ceiling still exists as a circuit breaker. If it trips we are already
 * in an incident and protecting the database outranks the retry loop.
 *
 * The counter is per-process and in-memory. Behind more than one instance each
 * process throttles independently, which is acceptable for a delay-based
 * control; a shared store would be required if this ever became a reject-based
 * limiter.
 */

export const createThrottle = (overrides = {}) => {
  const settings = { ...config.throttle, ...overrides };
  const buckets = new Map();

  const sweep = (now) => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.start >= settings.windowMs) buckets.delete(key);
    }
  };

  const middleware = (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 10000) sweep(now);

    const key = req.ip || "unknown";
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.start >= settings.windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > settings.hardMax) {
      logger.warn("throttle circuit breaker tripped", {
        ip: key,
        count: bucket.count,
        path: req.path,
      });
      res.set("Retry-After", Math.ceil(settings.windowMs / 1000));
      return res.status(429).json({
        code: 429,
        status: "Error",
        message: "Too many requests",
      });
    }

    const over = bucket.count - settings.after;
    if (over <= 0) return next();

    const delay = Math.min(over * settings.delayMs, settings.maxDelayMs);

    return new Promise((resolve) => setTimeout(resolve, delay)).then(() => {
      if (res.writableEnded) return undefined;
      return next();
    });
  };

  middleware.reset = () => buckets.clear();
  return middleware;
};

export const throttle = createThrottle();

export const resetThrottle = () => throttle.reset();
