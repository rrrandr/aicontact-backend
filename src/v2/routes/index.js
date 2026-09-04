import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "../../config/env";
import { requireAuth } from "../middleware/requireAuth";
import { idempotency } from "../middleware/idempotency";
import * as auth from "../controllers/authController";
import * as me from "../controllers/meController";
import * as entitlements from "../controllers/entitlementController";
import * as webhooks from "../controllers/webhookController";
import * as billingReturn from "../controllers/billingReturnController";

// v2 clients do not have v1's unbounded retry behaviour, so rejection-based
// limiting is safe throughout.
const limiter = (max, windowMs = config.rateLimit.authWindowMs) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({
        status: "Error",
        code: "rate_limited",
        message: "Too many attempts. Please try again later.",
      }),
  });

export const createV2Router = () => {
  const v2 = config.rateLimit.v2;

  const router = express.Router();

  router.use((req, res, next) => {
    res.set("X-API-Version", "2");
    next();
  });

  router.post("/auth/register", limiter(v2.register), auth.register);
  router.post("/auth/login", limiter(v2.login), auth.login);
  router.post("/auth/refresh", limiter(v2.refresh), auth.refresh);
  router.post("/auth/logout", auth.logout);
  router.post("/auth/password/forgot", limiter(v2.forgot), auth.forgotPassword);
  router.post("/auth/password/reset", limiter(v2.reset), auth.resetPassword);

  router.get("/me", requireAuth, me.getMe);
  router.patch("/me", requireAuth, me.patchMe);
  router.delete("/me", requireAuth, limiter(v2.remove), me.deleteMe);

  router.get("/entitlements", requireAuth, entitlements.getEntitlement);
  // Apple routes exist only when Apple is enabled. Mounting a verification
  // endpoint that cannot be configured would answer requests it can never
  // honour; absent is clearer than broken.
  if (config.appleEnabled) {
    router.post(
      "/entitlements/apple/verify",
      requireAuth,
      limiter(v2.entitlement),
      idempotency,
      entitlements.verifyApple
    );
  }
  router.post(
    "/entitlements/paypal/subscription",
    requireAuth,
    limiter(v2.entitlement),
    idempotency,
    entitlements.createPaypalSubscription
  );
  router.post(
    "/entitlements/paypal/claim-legacy/start",
    requireAuth,
    limiter(v2.forgot),
    entitlements.startLegacyPaypalClaim
  );
  router.post(
    "/entitlements/paypal/claim-legacy/confirm",
    requireAuth,
    limiter(v2.reset),
    entitlements.confirmLegacyPaypalClaim
  );
  router.post(
    "/entitlements/paypal/link",
    requireAuth,
    limiter(v2.entitlement),
    idempotency,
    entitlements.linkPaypal
  );

  // Browser landing pages for the PayPal approval round trip. Public by
  // necessity: the browser returning from PayPal carries no app session.
  // They render a message and nothing else - no state is read or written.
  router.get("/billing/return", billingReturn.billingReturn);
  router.get("/billing/cancel", billingReturn.billingCancel);

  // Provider-authenticated, not user-authenticated. Both verify their own
  // signatures inside the handler.
  if (config.appleEnabled) {
    router.post("/webhooks/apple", webhooks.appleWebhook);
  }
  router.post("/webhooks/paypal", webhooks.paypalWebhook);

  return router;
};
