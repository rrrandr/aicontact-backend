import request from "supertest";
import { createApp } from "../src/app";
import { User } from "../src/models/user";
import { PaypalSubscription } from "../src/models/paypalSubscription";
import { Entitlement } from "../src/models/entitlement";
import { getSubscription } from "../src/v2/services/paypalService";
import { tail } from "../src/util/redact";
import {
  readState,
  writeState,
  resolveSubscriptionId,
  subscriptionSource,
} from "../scripts/lib/sandboxState";

const { describeSandbox, log } = require("./guard");

const PASSWORD = "a-sufficiently-long-password";

describeSandbox("PayPal sandbox lifecycle", () => {
  const app = createApp();
  const planId = (process.env.PAYPAL_PLAN_IDS || "").split(",")[0].trim();

  // Phase 1 records what it creates, so nothing has to be copied by hand.
  // The environment variable is an override, and a disagreement is refused
  // rather than resolved by precedence.
  const startingState = readState();
  const approvedId = resolveSubscriptionId({
    envValue: process.env.PAYPAL_TEST_SUBSCRIPTION_ID,
    state: startingState,
  });

  const register = async (email, subjectId) => {
    const res = await request(app)
      .post("/api/v2/auth/register")
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(201);

    if (subjectId) {
      // Phase 2 runs against a fresh database, so the account has to carry the
      // same subject_id the approved subscription was bound to.
      await User.updateOne(
        { email_norm: email },
        { $set: { subject_id: subjectId } }
      );
    }
    return res.body;
  };

  const authed = (req, tokens) =>
    req.set("Authorization", `Bearer ${tokens.access_token}`);

  /* ---------------------------------------------------------------- *
   * Phase 1 - runs when no approved subscription id is configured.
   * Creates a subscription and hands back a URL for the browser step.
   * ---------------------------------------------------------------- */

  (approvedId ? describe.skip : describe)("phase 1: server-created subscription", () => {
    it("creates a subscription bound to the authenticated account", async () => {
      const email = `sandbox-phase1-${Date.now()}@example.com`;
      const tokens = await register(email);
      const user = await User.findOne({ email_norm: email });

      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/subscription"),
        tokens
      ).send({ plan_id: planId });

      expect(res.status).toBe(201);
      expect(res.body.subscription_id).toEqual(expect.any(String));
      expect(res.body.approve_url).toContain("paypal.com");

      // The binding must come from the session, not the request.
      const remote = await getSubscription(res.body.subscription_id);
      expect(remote).toBeTruthy();
      expect(remote.custom_id).toBe(user.subject_id);
      expect(remote.plan_id).toBe(planId);

      writeState({
        subject_id: user.subject_id,
        subscription_id: res.body.subscription_id,
        approve_url: res.body.approve_url,
        created_at: new Date().toISOString(),
      });

      log(`\n  subscription created: ${tail(res.body.subscription_id, 6)}`);
      log(`  bound to subject:     ${tail(user.subject_id, 6)}`);
      log(`  state written to:     .paypal-sandbox-state.json`);
      log(`\n  NEXT (manual): open the approve_url from that file in a browser,`);
      log(`  sign in with a sandbox PERSONAL buyer account, and approve.`);
      log(`  Then simply re-run - phase 2 picks the id up from the state file.\n`);
    });
  });

  /* ---------------------------------------------------------------- *
   * Phase 2 - runs once an approved subscription id is configured.
   * ---------------------------------------------------------------- */

  (approvedId ? describe : describe.skip)("phase 2: approved subscription", () => {
    const state = startingState;
    let tokens;
    let email;

    beforeAll(async () => {
      log(`  subscription id source: ${subscriptionSource({ envValue: process.env.PAYPAL_TEST_SUBSCRIPTION_ID, state })}`);
      if (!state.subject_id) {
        throw new Error(
          "No subject_id in .paypal-sandbox-state.json - run phase 1 first so the " +
            "account can be recreated with the subject the subscription is bound to."
        );
      }
      email = `sandbox-phase2-${Date.now()}@example.com`;
      tokens = await register(email, state.subject_id);
    });

    it("is ACTIVE at PayPal after buyer approval", async () => {
      const remote = await getSubscription(approvedId);
      expect(remote).toBeTruthy();
      log(`  PayPal reports status: ${remote.status}`);

      if (remote.status === "APPROVAL_PENDING") {
        throw new Error(
          "This subscription has not been approved yet. Open approve_url from " +
            ".paypal-sandbox-state.json, approve it with a sandbox personal buyer " +
            "account, then re-run."
        );
      }

      expect(["ACTIVE", "APPROVED"]).toContain(remote.status);
    });

    it("links, verifying ownership through custom_id", async () => {
      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        tokens
      ).send({ subscription_id: approvedId });

      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(true);
      expect(res.body.entitlement.platform).toBe("paypal");
    });

    it("refuses the same subscription from a different account", async () => {
      const other = await register(`sandbox-other-${Date.now()}@example.com`);
      const res = await authed(
        request(app).post("/api/v2/entitlements/paypal/link"),
        other
      ).send({ subscription_id: approvedId });

      expect([403, 409]).toContain(res.status);
    });

    it("is idempotent when the same link is delivered twice", async () => {
      const send = () =>
        authed(request(app).post("/api/v2/entitlements/paypal/link"), tokens)
          .set("Idempotency-Key", `sandbox-${state.subscription_id}`)
          .send({ subscription_id: approvedId });

      const first = await send();
      const second = await send();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await PaypalSubscription.countDocuments({ subscription_id: approvedId })).toBe(1);
    });

    it("keeps the v1 field in step for released clients", async () => {
      const user = await User.findOne({ email_norm: email });
      expect(user.subscription_date).not.toBe("");
      expect(Number.isNaN(Date.parse(user.subscription_date))).toBe(false);
    });

    it("refreshes authoritative state from PayPal", async () => {
      // The entitlement's expiry must track PayPal's next_billing_time, not
      // anything the client said.
      const remote = await getSubscription(approvedId);
      const entitlement = await Entitlement.findOne({ platform: "paypal" });

      if (remote.billing_info && remote.billing_info.next_billing_time) {
        expect(entitlement.expires_at.toISOString().slice(0, 10)).toBe(
          new Date(remote.billing_info.next_billing_time).toISOString().slice(0, 10)
        );
      }
    });

    it("confirms cancellation from PayPal during account deletion", async () => {
      const res = await authed(request(app).delete("/api/v2/me"), tokens).send({
        password: PASSWORD,
      });

      log(`  deletion responded ${res.status}`);
      expect(res.status).toBe(200);
      expect(res.body.paypal_subscription_cancelled).toBe(true);

      // Independently verified against PayPal, not just our own response.
      const remote = await getSubscription(approvedId);
      expect(["CANCELLED", "EXPIRED"]).toContain(remote.status);
    });
  });
});
