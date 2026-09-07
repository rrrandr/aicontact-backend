import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { Entitlement } from "../../src/models/entitlement";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { PendingCancellation } from "../../src/models/pendingCancellation";
import { CancellationFeedback } from "../../src/models/cancellationFeedback";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { paypalSubscription, installFetchStub, paypalAuthRoute, DAY } from "../helpers/providers";

const PASSWORD = "a-sufficiently-long-password";

/** PayPal's cycle bookkeeping, which is the only thing that says trial or paid. */
const cycles = (phase) => [
  {
    tenure_type: "TRIAL",
    sequence: 1,
    total_cycles: 1,
    cycles_completed: phase === "trial" ? 0 : 1,
  },
  { tenure_type: "REGULAR", sequence: 2, total_cycles: 0, cycles_completed: phase === "trial" ? 0 : 1 },
];

describe("cancelling a subscription from the app", () => {
  const app = createApp();
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    resetTokenCache();
  });

  const register = async (email) =>
    (await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })).body;

  /**
   * Stubs PayPal and links a live subscription to the account, so every test
   * starts from a subscriber in the phase it cares about.
   */
  const subscribe = async ({ email, id, phase = "paid", endsInDays = 20 }) => {
    const tokens = await register(email);
    const user = await User.findOne({ email_norm: email });
    const endsAt = new Date(Date.now() + endsInDays * DAY);

    const live = () => ({
      body: paypalSubscription({
        id,
        custom_id: user.subject_id,
        status: "ACTIVE",
        billing_info: {
          next_billing_time: endsAt.toISOString(),
          cycle_executions: cycles(phase),
        },
      }),
    });

    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": live,
    });

    const linked = await request(app)
      .post("/api/v2/entitlements/paypal/link")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ subscription_id: id });
    expect(linked.status).toBe(200);

    return { tokens, user, endsAt, live };
  };

  /**
   * PayPal after a successful cancellation: no next billing time, because it
   * will not bill again.
   */
  const cancelledAtPaypal = (id) => ({
    body: paypalSubscription({ id, status: "CANCELLED", billing_info: {} }),
  });

  const cancel = (tokens, key) => {
    const req = request(app)
      .post("/api/v2/entitlements/paypal/cancel")
      .set("Authorization", `Bearer ${tokens.access_token}`);
    if (key) req.set("Idempotency-Key", key);
    return req.send({});
  };

  describe("a subscriber can only ever cancel their own subscription", () => {
    it("cancels the subscription belonging to the caller, not the one named", async () => {
      // There is no field in which to name a subscription: the endpoint reads
      // the caller's own record. This is the property under test.
      const victim = await subscribe({
        email: "cancel-victim@example.com",
        id: "I-VICTIM00001",
      });
      const attacker = await subscribe({
        email: "cancel-attacker@example.com",
        id: "I-ATTACKER001",
      });

      let cancelledIds = [];
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          const id = String(url).includes("I-VICTIM00001") ? "I-VICTIM00001" : "I-ATTACKER001";
          if (String(url).endsWith("/cancel")) {
            cancelledIds.push(id);
            return { status: 204, body: {} };
          }
          return cancelledIds.includes(id) ? cancelledAtPaypal(id) : attacker.live();
        },
      });

      // Even sending the victim's id, which the endpoint does not read.
      const res = await request(app)
        .post("/api/v2/entitlements/paypal/cancel")
        .set("Authorization", `Bearer ${attacker.tokens.access_token}`)
        .send({ subscription_id: "I-VICTIM00001" });

      expect(res.status).toBe(200);
      expect(cancelledIds).toEqual(["I-ATTACKER001"]);

      const untouched = await PaypalSubscription.findOne({ subscription_id: "I-VICTIM00001" });
      expect(untouched.cancelled_at).toBeFalsy();

      const victimEntitlement = await Entitlement.findOne({ user_id: victim.user._id });
      expect(victimEntitlement.auto_renew).toBe(true);
    });

    it("refuses when PayPal's own binding names a different account", async () => {
      // The account link alone would be enough to scope the request; the
      // binding PayPal echoes back is the independent second check.
      const { tokens } = await subscribe({
        email: "cancel-rebound@example.com",
        id: "I-REBOUND0001",
      });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-REBOUND0001",
            custom_id: "somebody-elses-subject-id",
            status: "ACTIVE",
          }),
        },
      });

      const res = await cancel(tokens);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("paypal_ownership_unverified");

      const record = await PaypalSubscription.findOne({ subscription_id: "I-REBOUND0001" });
      expect(record.cancelled_at).toBeFalsy();
    });

    it("never returns a subscription id in the response", async () => {
      const { tokens } = await subscribe({
        email: "cancel-noid@example.com",
        id: "I-NOIDLEAK001",
      });

      let cancelled = false;
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          if (String(url).endsWith("/cancel")) {
            cancelled = true;
            return { status: 204, body: {} };
          }
          return cancelled
            ? cancelledAtPaypal("I-NOIDLEAK001")
            : { body: paypalSubscription({ id: "I-NOIDLEAK001", custom_id: "x" }) };
        },
      });

      const view = await request(app)
        .get("/api/v2/entitlements/subscription")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(JSON.stringify(view.body)).not.toContain("I-NOIDLEAK001");
    });

    it("lets a legacy claim cancel while PayPal still holds no binding", async () => {
      // Subscriptions that pre-date server-side binding proved ownership by a
      // code emailed to the address PayPal holds. There is no custom_id to
      // check, so the claim itself is the proof.
      const tokens = await register("cancel-legacy@example.com");
      const user = await User.findOne({ email_norm: "cancel-legacy@example.com" });
      await PaypalSubscription.create({
        subscription_id: "I-LEGACY00001",
        user_id: user._id,
        legacy_claim: true,
        status: "ACTIVE",
        next_billing_time: new Date(Date.now() + 11 * DAY),
      });

      let cancelled = false;
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          if (String(url).endsWith("/cancel")) {
            cancelled = true;
            return { status: 204, body: {} };
          }
          return cancelled
            ? cancelledAtPaypal("I-LEGACY00001")
            : { body: paypalSubscription({ id: "I-LEGACY00001", status: "ACTIVE" }) };
        },
      });

      const res = await cancel(tokens);
      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(true);
    });

    it("refuses a legacy claim once PayPal's binding names someone else", async () => {
      // A binding that contradicts the local record wins, whatever the record
      // says about how ownership was established.
      const tokens = await register("cancel-legacy-bound@example.com");
      const user = await User.findOne({ email_norm: "cancel-legacy-bound@example.com" });
      await PaypalSubscription.create({
        subscription_id: "I-LEGACYBND01",
        user_id: user._id,
        legacy_claim: true,
        status: "ACTIVE",
      });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": {
          body: paypalSubscription({
            id: "I-LEGACYBND01",
            custom_id: "somebody-elses-subject-id",
            status: "ACTIVE",
          }),
        },
      });

      const res = await cancel(tokens);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("paypal_ownership_unverified");
    });

    it("tells an account with no subscription that there is nothing to cancel", async () => {
      const tokens = await register("cancel-none@example.com");
      const res = await cancel(tokens);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("no_subscription");
    });

    it("requires a session", async () => {
      const res = await request(app).post("/api/v2/entitlements/paypal/cancel").send({});
      expect(res.status).toBe(401);
    });
  });

  describe("PayPal has to confirm before anything is called cancelled", () => {
    it("fails closed when the cancellation cannot be confirmed", async () => {
      const { tokens, user } = await subscribe({
        email: "cancel-unconfirmed@example.com",
        id: "I-UNCONF00001",
      });

      // The call fails and PayPal still reports the subscription active.
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) =>
          String(url).endsWith("/cancel")
            ? { status: 500, body: {} }
            : {
                body: paypalSubscription({
                  id: "I-UNCONF00001",
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                }),
              },
      });

      const res = await cancel(tokens);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("cancellation_unconfirmed");
      expect(res.body.retry).toBe(true);
      // Somewhere useful to go while it is retried.
      expect(res.body.manage_url).toContain("paypal.com");
    });

    it("does not record a cancellation the database alone believes in", async () => {
      const { tokens, user } = await subscribe({
        email: "cancel-nolocal@example.com",
        id: "I-NOLOCAL0001",
      });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) =>
          String(url).endsWith("/cancel")
            ? { status: 422, body: { details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] } }
            : {
                body: paypalSubscription({
                  id: "I-NOLOCAL0001",
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                }),
              },
      });

      await cancel(tokens);

      const record = await PaypalSubscription.findOne({ subscription_id: "I-NOLOCAL0001" });
      expect(record.cancelled_at).toBeFalsy();
      expect(record.access_ends_at).toBeFalsy();

      const entitlement = await Entitlement.findOne({ user_id: user._id });
      expect(entitlement.cancelled_at).toBeFalsy();
      expect(entitlement.auto_renew).toBe(true);
    });

    it("leaves a durable retry job behind when PayPal will not confirm", async () => {
      const { tokens, user } = await subscribe({
        email: "cancel-job@example.com",
        id: "I-CANCJOB0001",
      });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) =>
          String(url).endsWith("/cancel")
            ? { status: 500, body: {} }
            : {
                body: paypalSubscription({
                  id: "I-CANCJOB0001",
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                }),
              },
      });

      await cancel(tokens);

      const job = await PendingCancellation.findOne({ subscription_id: "I-CANCJOB0001" });
      expect(job).toBeTruthy();
      expect(job.resolved_at).toBeFalsy();
      expect(job.attempts).toBeGreaterThan(0);
    });

    it("does not accept a suspended subscription as cancelled", async () => {
      // Suspension pauses collection and can be reactivated, so it settles
      // nothing about whether the subscriber will be charged again.
      const { tokens, user } = await subscribe({
        email: "cancel-suspended@example.com",
        id: "I-SUSPEND0001",
      });

      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) =>
          String(url).endsWith("/cancel")
            ? { status: 500, body: {} }
            : {
                body: paypalSubscription({
                  id: "I-SUSPEND0001",
                  custom_id: user.subject_id,
                  status: "SUSPENDED",
                }),
              },
      });

      const res = await cancel(tokens);
      expect(res.status).toBe(503);
    });
  });

  describe("access lasts to the end of what was already paid for", () => {
    it("keeps a paid month running after cancellation", async () => {
      const { tokens, user, endsAt } = await subscribe({
        email: "cancel-paid@example.com",
        id: "I-PAIDEND0001",
        phase: "paid",
        endsInDays: 20,
      });

      let cancelled = false;
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          if (String(url).endsWith("/cancel")) {
            cancelled = true;
            return { status: 204, body: {} };
          }
          return cancelled
            ? cancelledAtPaypal("I-PAIDEND0001")
            : {
                body: paypalSubscription({
                  id: "I-PAIDEND0001",
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                  billing_info: {
                    next_billing_time: endsAt.toISOString(),
                    cycle_executions: cycles("paid"),
                  },
                }),
              };
        },
      });

      const res = await cancel(tokens);

      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(true);
      expect(res.body.subscription.state).toBe("cancelled");
      expect(res.body.subscription.phase).toBe("paid");
      expect(res.body.subscription.next_renewal_at).toBeNull();
      expect(new Date(res.body.subscription.access_ends_at).getTime()).toBe(endsAt.getTime());

      // Still entitled, and the entitlement carries the same end date.
      expect(res.body.entitlement.active).toBe(true);
      expect(res.body.entitlement.auto_renew).toBe(false);

      const entitlement = await Entitlement.findOne({ user_id: user._id });
      expect(entitlement.access_ends_at.getTime()).toBe(endsAt.getTime());
    });

    it("keeps a cancelled trial only to the trial's scheduled end", async () => {
      // The trial is not a paid period. Cancelling during it must not buy the
      // subscriber a month they never paid for, and must not cut short the
      // days of trial they were offered either.
      const trialEnd = new Date(Date.now() + 6 * DAY);
      const { tokens, user } = await subscribe({
        email: "cancel-trial@example.com",
        id: "I-TRIALEND001",
        phase: "trial",
        endsInDays: 6,
      });

      let cancelled = false;
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          if (String(url).endsWith("/cancel")) {
            cancelled = true;
            return { status: 204, body: {} };
          }
          return cancelled
            ? cancelledAtPaypal("I-TRIALEND001")
            : {
                body: paypalSubscription({
                  id: "I-TRIALEND001",
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                  billing_info: {
                    next_billing_time: trialEnd.toISOString(),
                    cycle_executions: cycles("trial"),
                  },
                }),
              };
        },
      });

      const res = await cancel(tokens);

      expect(res.status).toBe(200);
      expect(res.body.subscription.phase).toBe("trial");

      const ends = new Date(res.body.subscription.access_ends_at).getTime();
      // The trial's own end, within a second of it, and nothing like a month.
      expect(Math.abs(ends - trialEnd.getTime())).toBeLessThan(1000);
      expect(ends).toBeLessThan(Date.now() + 7 * DAY);
      expect(res.body.entitlement.active).toBe(true);
    });

    it("reports no access left when the paid period has already elapsed", async () => {
      const { tokens, user } = await subscribe({
        email: "cancel-elapsed@example.com",
        id: "I-ELAPSED0001",
      });

      let cancelled = false;
      const elapsed = new Date(Date.now() - DAY);
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          if (String(url).endsWith("/cancel")) {
            cancelled = true;
            return { status: 204, body: {} };
          }
          return cancelled
            ? cancelledAtPaypal("I-ELAPSED0001")
            : {
                body: paypalSubscription({
                  id: "I-ELAPSED0001",
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                  billing_info: { next_billing_time: elapsed.toISOString() },
                }),
              };
        },
      });

      const res = await cancel(tokens);
      expect(res.status).toBe(200);
      expect(res.body.entitlement.active).toBe(false);
    });
  });

  describe("cancelling twice", () => {
    const setUpDoubleClick = async (email, id) => {
      const { tokens, user, endsAt } = await subscribe({ email, id, endsInDays: 25 });

      const calls = { cancel: 0 };
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          if (String(url).endsWith("/cancel")) {
            calls.cancel += 1;
            return { status: 204, body: {} };
          }
          return calls.cancel > 0
            ? cancelledAtPaypal(id)
            : {
                body: paypalSubscription({
                  id,
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                  billing_info: {
                    next_billing_time: endsAt.toISOString(),
                    cycle_executions: cycles("paid"),
                  },
                }),
              };
        },
      });

      return { tokens, user, endsAt, calls };
    };

    it("answers a second click with success, not an error", async () => {
      const { tokens, calls } = await setUpDoubleClick(
        "cancel-twice@example.com",
        "I-TWICE000001"
      );

      const first = await cancel(tokens);
      const second = await cancel(tokens);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.cancelled).toBe(true);
      expect(second.body.already_cancelled).toBe(true);
      // The second click did not reach PayPal at all.
      expect(calls.cancel).toBe(1);
    });

    it("does not let the second click shorten the access it granted", async () => {
      // The trap: by the second click PayPal no longer reports a next billing
      // time, so re-deriving the access-end date would replace a real date
      // with nothing.
      const { tokens, user, endsAt } = await setUpDoubleClick(
        "cancel-twice-date@example.com",
        "I-TWICEDATE01"
      );

      await cancel(tokens);
      const second = await cancel(tokens);

      expect(new Date(second.body.subscription.access_ends_at).getTime()).toBe(
        endsAt.getTime()
      );

      const entitlement = await Entitlement.findOne({ user_id: user._id });
      expect(entitlement.access_ends_at.getTime()).toBe(endsAt.getTime());
      expect(entitlement.status).toBe("active");
    });

    it("replays the stored response when the same Idempotency-Key is reused", async () => {
      const { tokens } = await setUpDoubleClick(
        "cancel-idem@example.com",
        "I-IDEMKEY0001"
      );

      const first = await cancel(tokens, "cancel-key-1");
      const second = await cancel(tokens, "cancel-key-1");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.headers["idempotent-replay"]).toBe("true");
    });
  });

  describe("the management view", () => {
    it("describes an active paid subscription with its renewal date", async () => {
      const { tokens, endsAt } = await subscribe({
        email: "view-active@example.com",
        id: "I-VIEWACTIVE1",
        phase: "paid",
      });

      const res = await request(app)
        .get("/api/v2/entitlements/subscription")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(res.status).toBe(200);
      expect(res.body.subscription.state).toBe("active");
      expect(res.body.subscription.auto_renew).toBe(true);
      expect(res.body.subscription.can_cancel).toBe(true);
      expect(new Date(res.body.subscription.next_renewal_at).getTime()).toBe(endsAt.getTime());
      expect(res.body.subscription.manage_url).toContain("paypal.com");
    });

    it("describes a trial as a trial", async () => {
      const { tokens } = await subscribe({
        email: "view-trial@example.com",
        id: "I-VIEWTRIAL01",
        phase: "trial",
      });

      const res = await request(app)
        .get("/api/v2/entitlements/subscription")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(res.body.subscription.state).toBe("trialing");
      expect(res.body.subscription.phase).toBe("trial");
    });

    it("does not call an unapproved subscription 'no subscription'", async () => {
      // Created, never approved: saying there is no subscription next to a
      // Cancel button would contradict itself.
      const tokens = await register("view-pending@example.com");
      const user = await User.findOne({ email_norm: "view-pending@example.com" });
      await PaypalSubscription.create({
        subscription_id: "I-VIEWPEND001",
        user_id: user._id,
        status: "APPROVAL_PENDING",
      });

      const res = await request(app)
        .get("/api/v2/entitlements/subscription")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(res.body.subscription.state).toBe("pending");
      expect(res.body.subscription.can_cancel).toBe(true);
    });

    it("offers nothing to cancel on an account that has never subscribed", async () => {
      const tokens = await register("view-none@example.com");
      const res = await request(app)
        .get("/api/v2/entitlements/subscription")
        .set("Authorization", `Bearer ${tokens.access_token}`);

      expect(res.body.subscription.state).toBe("none");
      expect(res.body.subscription.can_cancel).toBe(false);
    });
  });

  describe("feedback is optional", () => {
    const cancelSuccessfully = async (email, id) => {
      const { tokens, user, endsAt } = await subscribe({ email, id });
      let cancelled = false;
      installFetchStub({
        ...paypalAuthRoute,
        "/v1/billing/subscriptions/": (url) => {
          if (String(url).endsWith("/cancel")) {
            cancelled = true;
            return { status: 204, body: {} };
          }
          return cancelled
            ? cancelledAtPaypal(id)
            : {
                body: paypalSubscription({
                  id,
                  custom_id: user.subject_id,
                  status: "ACTIVE",
                  billing_info: { next_billing_time: endsAt.toISOString() },
                }),
              };
        },
      });
      const res = await cancel(tokens);
      expect(res.status).toBe(200);
      return { tokens, user, res };
    };

    it("completes the cancellation without any feedback at all", async () => {
      const { user } = await cancelSuccessfully("fb-skip@example.com", "I-FBSKIP00001");

      const record = await PaypalSubscription.findOne({ user_id: user._id });
      expect(record.cancelled_at).toBeTruthy();
      // Nothing was stored, and nothing asked for.
      expect(await CancellationFeedback.findOne({ subject_id: user.subject_id })).toBeNull();
    });

    it("offers reasons in the cancellation response rather than demanding one", async () => {
      const { res } = await cancelSuccessfully("fb-offer@example.com", "I-FBOFFER0001");
      // The same list the client renders. Written down on both sides because
      // the server rejects a code it did not offer, so the two must agree;
      // Assets/Tests/EditMode/SubscriptionManagementTests.cs pins the other half.
      expect(res.body.feedback_reasons).toEqual([
        "too_expensive",
        "not_using_it",
        "missing_features",
        "technical_problems",
        "temporary_break",
        "other",
      ]);
    });

    it("accepts feedback afterwards, comment and all", async () => {
      const { tokens, user } = await cancelSuccessfully("fb-give@example.com", "I-FBGIVE00001");

      const res = await request(app)
        .post("/api/v2/entitlements/paypal/cancel/feedback")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ reason_code: "too_expensive", comment: "A bit steep for me." });

      expect(res.status).toBe(200);
      const stored = await CancellationFeedback.findOne({ subject_id: user.subject_id });
      expect(stored.reason_code).toBe("too_expensive");
    });

    it("accepts a reason with no comment and a comment with no reason", async () => {
      const a = await cancelSuccessfully("fb-partial-a@example.com", "I-FBPARTA0001");
      const reasonOnly = await request(app)
        .post("/api/v2/entitlements/paypal/cancel/feedback")
        .set("Authorization", `Bearer ${a.tokens.access_token}`)
        .send({ reason_code: "not_using_it" });
      expect(reasonOnly.status).toBe(200);

      const b = await cancelSuccessfully("fb-partial-b@example.com", "I-FBPARTB0001");
      const commentOnly = await request(app)
        .post("/api/v2/entitlements/paypal/cancel/feedback")
        .set("Authorization", `Bearer ${b.tokens.access_token}`)
        .send({ comment: "Just taking a break." });
      expect(commentOnly.status).toBe(200);
    });

    it("cannot be submitted before a cancellation has succeeded", async () => {
      // Feedback must never become a step on the way to cancelling.
      const { tokens } = await subscribe({
        email: "fb-early@example.com",
        id: "I-FBEARLY0001",
      });

      const res = await request(app)
        .post("/api/v2/entitlements/paypal/cancel/feedback")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ reason_code: "too_expensive" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("no_cancellation");
    });

    it("rejects a reason that was never offered", async () => {
      const { tokens } = await cancelSuccessfully("fb-bogus@example.com", "I-FBBOGUS0001");
      const res = await request(app)
        .post("/api/v2/entitlements/paypal/cancel/feedback")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ reason_code: "because" });
      expect(res.status).toBe(400);
    });
  });
});
