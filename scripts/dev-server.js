/**
 * A throwaway backend for manual testing of the desktop client.
 *
 * Boots an in-memory MongoDB, starts the real application against it, and
 * seeds an account that is already entitled - so the consent, camera,
 * recording and cancellation flows can be walked through without creating a
 * production account, without a live PayPal call, and without anyone needing
 * to remember a password.
 *
 * Everything it writes disappears when the process stops.
 *
 *   npm run dev:server
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const EMAIL = process.env.DEV_EMAIL || "test@aicontact.local";
const PASSWORD = process.env.DEV_PASSWORD || "a-sufficiently-long-password";
// Not 5000: macOS AirPlay Receiver (ControlCenter) listens there and answers 403.
const PORT = Number(process.env.PORT || 5055);

/**
 * A PayPal that lives in this process.
 *
 * The seeded subscription does not exist at PayPal, so the real cancellation
 * path refuses to confirm it and fails closed - which is correct, and which
 * makes the cancel button untestable locally. This answers the four calls the
 * backend makes, so the whole flow can be walked through: read the
 * subscription, cancel it, read it back as cancelled.
 *
 * Only PayPal hosts are intercepted; everything else goes to the real network.
 */
const installLocalPaypal = () => {
  const realFetch = globalThis.fetch;
  const cancelled = new Set();

  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.includes("paypal.com")) return realFetch(url, options);

    if (target.includes("/v1/oauth2/token")) {
      return json({ access_token: "local-dev-token", expires_in: 3600 });
    }

    if (target.includes("/v1/notifications/verify-webhook-signature")) {
      return json({ verification_status: "SUCCESS" });
    }

    const match = target.match(/\/v1\/billing\/subscriptions\/([^/?]+)/);
    if (match) {
      const id = decodeURIComponent(match[1]);

      if (target.endsWith("/cancel")) {
        cancelled.add(id);
        console.log(`  [local paypal] cancelled ${id}`);
        return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
      }

      const isCancelled = cancelled.has(id);
      return json({
        id,
        plan_id: process.env.PAYPAL_PLAN_IDS,
        status: isCancelled ? "CANCELLED" : "ACTIVE",
        custom_id: global.__devSubjectId,
        start_time: new Date(Date.now() - 86400000).toISOString(),
        billing_info: isCancelled
          ? {}
          : {
              next_billing_time: new Date(Date.now() + 30 * 86400000).toISOString(),
              cycle_executions: [
                { tenure_type: "TRIAL", sequence: 1, total_cycles: 1, cycles_completed: 1 },
                { tenure_type: "REGULAR", sequence: 2, total_cycles: 0, cycles_completed: 1 },
              ],
            },
      });
    }

    return json({ message: "unstubbed paypal call: " + target }, 404);
  };
};

const start = async () => {
  installLocalPaypal();
  const mongo = await MongoMemoryServer.create();

  process.env.URI = mongo.getUri();
  process.env.NODE_ENV = "development";
  process.env.ENABLE_V2 = "true";
  process.env.ENABLE_APPLE = "false";
  process.env.PORT = String(PORT);
  process.env.JWT_ACCESS_SECRET =
    process.env.JWT_ACCESS_SECRET || "local-development-secret-that-is-long-enough-ok";
  process.env.BCRYPT_COST = "6";
  // Present so config validation passes. No PayPal call is made: the seeded
  // account is already entitled.
  process.env.PAYPAL_CLIENT_ID = "local-dev";
  process.env.PAYPAL_CLIENT_SECRET = "local-dev";
  process.env.PAYPAL_WEBHOOK_ID = "local-dev";
  process.env.PAYPAL_PLAN_IDS = "P-LOCALDEV0001";
  process.env.PAYPAL_ENV = "sandbox";
  // Password reset prints its link to this console instead of vanishing.
  process.env.MAIL_PROVIDER = "log";

  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user");
  const { Entitlement } = await import("../src/models/entitlement");
  const { PaypalSubscription } = await import("../src/models/paypalSubscription");
  const { newSubjectId } = await import("../src/util/crypto");
  const { normalizeEmail } = await import("../src/util/email");

  await mongoose.connect(process.env.URI);

  const subjectId = newSubjectId();
  // The local PayPal echoes this back as custom_id, which is what proves
  // ownership when the subscription is cancelled.
  global.__devSubjectId = subjectId;
  const user = await User.create({
    email: EMAIL,
    email_norm: normalizeEmail(EMAIL),
    password: await bcrypt.hash(PASSWORD, 6),
    subject_id: subjectId,
    terms_accepted: "false",
    status: "active",
  });

  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await PaypalSubscription.create({
    subscription_id: "I-LOCALDEV001",
    user_id: user._id,
    plan_id: "P-LOCALDEV0001",
    status: "ACTIVE",
    phase: "paid",
    activated_at: new Date(),
    next_billing_time: inThirtyDays,
  });

  await Entitlement.create({
    user_id: user._id,
    subject_id: subjectId,
    platform: "paypal",
    product_id: "P-LOCALDEV0001",
    status: "active",
    starts_at: new Date(),
    expires_at: inThirtyDays,
    auto_renew: true,
    environment: "Sandbox",
    source_ref: "I-LOCALDEV001",
  });

  const app = createApp();

  // Development-only lever, so a lapse can be watched without waiting a month.
  // It exists in this script and nowhere else.
  app.post("/__dev/expire", async (_req, res) => {
    const past = new Date(Date.now() - 60000);
    await Entitlement.updateMany({}, { $set: { expires_at: past, status: "expired" } });
    console.log("  [dev] entitlement expired; the client should end the session");
    res.json({ status: "Success", expired_at: past.toISOString() });
  });

  app.post("/__dev/restore", async (_req, res) => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await Entitlement.updateMany({}, { $set: { expires_at: future, status: "active" } });
    console.log("  [dev] entitlement restored");
    res.json({ status: "Success", expires_at: future.toISOString() });
  });

  app.listen(PORT, () => {
    console.log("");
    console.log("  AICONTACT local backend");
    console.log("  ----------------------------------------------------");
    console.log(`  listening   http://localhost:${PORT}`);
    console.log(`  email       ${EMAIL}`);
    console.log(`  password    ${PASSWORD}`);
    console.log("  entitled    yes, paid, renews in 30 days");
    console.log("  consents    none recorded - the app will ask");
    console.log("");
    console.log("  Launch the client against it with:");
    console.log(`    AICONTACT_API_BASE=http://localhost:${PORT} \\`);
    console.log("      <build>/AICONTACT-Test.app/Contents/MacOS/AICONTACT");
    console.log("");
    console.log("  PayPal is stubbed in-process, so Cancel Subscription works.");
    console.log("");
    console.log("  To watch access lapse without waiting a month:");
    console.log(`    curl -X POST http://localhost:${PORT}/__dev/expire`);
    console.log(`    curl -X POST http://localhost:${PORT}/__dev/restore`);
    console.log("");
    console.log("  To start over with a fresh account and no recorded consents:");
    console.log("    Ctrl-C, then npm run dev:server, then clear the client with");
    console.log("    defaults delete com.FaceStreamCorporation.AICONTACT");
    console.log("");
    console.log("  Nothing here is persisted. Ctrl-C throws it all away.");
    console.log("");
  });
};

start().catch((error) => {
  console.error("dev server failed to start:", error);
  process.exit(1);
});
