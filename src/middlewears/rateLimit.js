import rateLimit from "express-rate-limit";
import { config } from "../config/env";
import { logger } from "../util/logger";

/**
 * Rejection-based limiting is safe ONLY on login and register.
 *
 * Both failure paths in the shipped client stop and show a message rather than
 * retrying (InAppPurchaseScreenHandler.cs:112-117 and 236-239), so a 429 here
 * costs a user one retry, not an infinite loop. Every other endpoint uses the
 * delay-based throttle instead - see src/middlewears/throttle.js.
 */
export const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("auth rate limit hit", { ip: req.ip, path: req.path });
    res.status(429).json({
      code: 429,
      status: "Error",
      message: "Too many attempts. Please try again later.",
    });
  },
});
