import request from "supertest";
import { createApp } from "../src/app";
import { verifyWebhookSignature } from "../src/v2/services/paypalService";

const { describeSandbox, log } = require("./guard");

/**
 * Webhook delivery needs a publicly reachable HTTPS endpoint, which a local
 * machine does not have. Until one exists these fail rather than skip, so a
 * green run never implies webhook handling was exercised.
 *
 * Set PAYPAL_SKIP_WEBHOOK_TESTS=1 to acknowledge the gap deliberately.
 */
describeSandbox("PayPal sandbox webhooks", () => {
  const app = createApp();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  const acknowledged = process.env.PAYPAL_SKIP_WEBHOOK_TESTS === "1";

  it("has a registered sandbox webhook", () => {
    if (!webhookId && acknowledged) {
      log("  PAYPAL_WEBHOOK_ID unset; gap acknowledged via PAYPAL_SKIP_WEBHOOK_TESTS=1");
      return;
    }
    expect(webhookId).toEqual(expect.any(String));
  });

  (webhookId ? it : it.skip)(
    "rejects an event whose signature PayPal cannot verify",
    async () => {
      // Real verification call, deliberately bogus headers.
      const verified = await verifyWebhookSignature(
        {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/x",
          "paypal-transmission-id": "00000000-0000-0000-0000-000000000000",
          "paypal-transmission-sig": "not-a-real-signature",
          "paypal-transmission-time": new Date().toISOString(),
        },
        JSON.stringify({ id: "WH-TEST", event_type: "BILLING.SUBSCRIPTION.CANCELLED" })
      );

      expect(verified).toBe(false);
    }
  );

  (webhookId ? it : it.skip)("refuses an unverifiable event at the endpoint", async () => {
    const res = await request(app)
      .post("/api/v2/webhooks/paypal")
      .set("paypal-auth-algo", "SHA256withRSA")
      .set("paypal-cert-url", "https://api.sandbox.paypal.com/v1/notifications/certs/x")
      .set("paypal-transmission-id", "00000000-0000-0000-0000-000000000000")
      .set("paypal-transmission-sig", "not-a-real-signature")
      .set("paypal-transmission-time", new Date().toISOString())
      .send({ id: "WH-TEST-ENDPOINT", event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: {} });

    expect(res.status).toBe(400);
  });
});
