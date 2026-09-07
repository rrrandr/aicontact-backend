import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { CancellationFeedback } from "../../src/models/cancellationFeedback";
import { ConsentRecord } from "../../src/models/consentRecord";
import { CustomerMessage } from "../../src/models/customerMessage";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { installFetchStub, paypalAuthRoute } from "../helpers/providers";

const PASSWORD = "a-sufficiently-long-password";

/**
 * Cancellation feedback is the one thing here held on consent rather than on a
 * contract or a legal obligation. Consent that cannot be withdrawn is not
 * consent, so these check that it can actually be taken back - both on demand
 * and as part of deleting the account.
 */
describe("withdrawing cancellation feedback", () => {
  const app = createApp();
  const realFetch = global.fetch;

  afterEach(async () => {
    global.fetch = realFetch;
    resetTokenCache();
    await CancellationFeedback.deleteMany({});
    await ConsentRecord.deleteMany({});
    await CustomerMessage.deleteMany({});
    await PaypalSubscription.deleteMany({});
    await User.deleteMany({});
  });

  /** An account with a cancelled subscription and feedback already given. */
  const withFeedback = async (email) => {
    const tokens = (
      await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })
    ).body;
    const user = await User.findOne({ email_norm: email });

    await PaypalSubscription.create({
      subscription_id: `I-${email}`,
      user_id: user._id,
      cancelled_at: new Date(),
    });

    const given = await request(app)
      .post("/api/v2/entitlements/paypal/cancel/feedback")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ reason_code: "too_expensive", comment: "Please forget I said this." });
    expect(given.status).toBe(200);

    return { tokens, user };
  };

  it("tells the client that feedback exists, so it can offer to remove it", async () => {
    const { tokens } = await withFeedback("shown@example.com");

    const view = await request(app)
      .get("/api/v2/entitlements/subscription")
      .set("Authorization", `Bearer ${tokens.access_token}`);

    expect(view.status).toBe(200);
    expect(view.body.feedback_given).toBe(true);
  });

  it("deletes it on request", async () => {
    const { tokens, user } = await withFeedback("withdraw@example.com");

    const removed = await request(app)
      .delete("/api/v2/entitlements/paypal/cancel/feedback")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});

    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(true);
    expect(await CancellationFeedback.findOne({ subject_id: user.subject_id })).toBeNull();
  });

  it("is content to delete feedback that is not there", async () => {
    const email = "nothing@example.com";
    const tokens = (
      await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })
    ).body;

    const removed = await request(app)
      .delete("/api/v2/entitlements/paypal/cancel/feedback")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});

    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(false);
  });

  it("removes only the caller's own feedback", async () => {
    const mine = await withFeedback("mine@example.com");
    const theirs = await withFeedback("theirs@example.com");

    await request(app)
      .delete("/api/v2/entitlements/paypal/cancel/feedback")
      .set("Authorization", `Bearer ${mine.tokens.access_token}`)
      .send({});

    expect(await CancellationFeedback.findOne({ subject_id: mine.user.subject_id })).toBeNull();
    expect(
      await CancellationFeedback.findOne({ subject_id: theirs.user.subject_id })
    ).not.toBeNull();
  });

  it("leaves the consent and notice records behind, which are evidence", async () => {
    // These are not held on consent and they are not the person's to withdraw:
    // one shows what was agreed, the other shows a required notice was sent.
    // Both must survive deletion, and both must stop naming the account.
    const email = "evidence@example.com";
    const tokens = (
      await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })
    ).body;
    const user = await User.findOne({ email_norm: email });

    await ConsentRecord.create({
      user_id: user._id,
      subject_id: user.subject_id,
      document: "terms",
      version: "2026-09-06.1",
      statement: "I have read the Terms of Service and agree to them",
    });
    await CustomerMessage.create({
      user_id: user._id,
      subject_id: user.subject_id,
      kind: "enrollment_confirmation",
      key: "I-EVIDENCE",
      status: "sent",
    });

    installFetchStub({ ...paypalAuthRoute });
    const deleted = await request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ password: PASSWORD });
    expect(deleted.status).toBe(200);

    const consent = await ConsentRecord.findOne({ subject_id: user.subject_id });
    expect(consent).not.toBeNull();
    expect(consent.user_id).toBeUndefined();

    const message = await CustomerMessage.findOne({ subject_id: user.subject_id });
    expect(message).not.toBeNull();
    expect(message.user_id).toBeUndefined();
  });

  it("goes when the account goes, rather than surviving against the subject id", async () => {
    const { tokens, user } = await withFeedback("deleted@example.com");

    installFetchStub({ ...paypalAuthRoute });

    const deleted = await request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({ password: PASSWORD });

    expect(deleted.status).toBe(200);
    expect(await CancellationFeedback.findOne({ subject_id: user.subject_id })).toBeNull();
  });
});
