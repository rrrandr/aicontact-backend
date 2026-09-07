import { User } from "../../src/models/user";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { CustomerMessage, MessageKind } from "../../src/models/customerMessage";
import * as mailService from "../../src/v2/services/mailService";
import * as paypalService from "../../src/v2/services/paypalService";
import {
  sendEnrollmentConfirmation,
  sendAnnualRenewalReminder,
  sendPriceChangeNotice,
  sendTermsChangeNotice,
  retryPendingMessages,
} from "../../src/v2/services/customerMail";
import { sendDueAnnualReminders } from "../../src/v2/services/maintenanceService";

const DAY = 24 * 60 * 60 * 1000;

/**
 * The messages are hard-wrapped for a plain-text reader, so a phrase can fall
 * across two lines. These assertions are about what the message says, not how
 * it is laid out.
 */
const flat = (text) => text.replace(/\s+/g, " ");

/** The plan as PayPal actually returns it: a trial cycle and a regular one. */
const plan = ({ amount = "6.00", currency = "USD", trialDays = 13 } = {}) => ({
  id: "P-PLAN",
  billing_cycles: [
    {
      tenure_type: "TRIAL",
      total_cycles: 1,
      frequency: { interval_unit: "DAY", interval_count: trialDays },
    },
    {
      tenure_type: "REGULAR",
      total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { value: amount, currency_code: currency } },
    },
  ],
});

describe("transactional mail to customers", () => {
  let sent;
  let sendMail;
  let getPlan;

  beforeEach(() => {
    sent = [];
    sendMail = jest.spyOn(mailService, "sendMail").mockImplementation(async (message) => {
      sent.push(message);
      return { delivered: true, adapter: "test" };
    });
    getPlan = jest.spyOn(paypalService, "getPlan").mockResolvedValue(plan());
  });

  afterEach(async () => {
    sendMail.mockRestore();
    getPlan.mockRestore();
    await CustomerMessage.deleteMany({});
    await User.deleteMany({});
    await PaypalSubscription.deleteMany({});
  });

  const subscriber = async (email = "sub@example.com") =>
    User.create({
      email,
      email_norm: email,
      password: "x".repeat(60),
      subject_id: `subj_${email}`,
    });

  describe("the enrollment confirmation", () => {
    it("quotes the price PayPal holds, not one we stored", async () => {
      const user = await subscriber();
      getPlan.mockResolvedValue(plan({ amount: "9.99", currency: "EUR" }));

      await sendEnrollmentConfirmation({
        user,
        subscriptionId: "I-ABC",
        planId: "P-PLAN",
        record: { next_billing_time: new Date("2026-10-01T00:00:00Z") },
      });

      expect(sent).toHaveLength(1);
      expect(flat(sent[0].text)).toContain("EUR 9.99 every month");
      expect(flat(sent[0].text)).toContain("13 days at no charge");
      expect(flat(sent[0].text)).toContain("October 1, 2026");
    });

    it("says how to cancel, which is the point of a retainable confirmation", async () => {
      const user = await subscriber();
      await sendEnrollmentConfirmation({
        user,
        subscriptionId: "I-ABC",
        planId: "P-PLAN",
        record: {},
      });

      expect(flat(sent[0].text)).toContain("Manage Subscription");
      expect(flat(sent[0].text)).toContain("Cancel Subscription");
      expect(flat(sent[0].text)).toContain("paypal.com/myaccount/autopay");
    });

    it("is sent once, however many times the webhook repeats", async () => {
      const user = await subscriber();
      const args = { user, subscriptionId: "I-ABC", planId: "P-PLAN", record: {} };

      await sendEnrollmentConfirmation(args);
      const second = await sendEnrollmentConfirmation(args);

      expect(second.duplicate).toBe(true);
      expect(sent).toHaveLength(1);
      expect(await CustomerMessage.countDocuments({ kind: MessageKind.enrollment })).toBe(1);
    });

    it("is deferred rather than sent without a price", async () => {
      const user = await subscriber();
      getPlan.mockResolvedValue(null);

      const result = await sendEnrollmentConfirmation({
        user,
        subscriptionId: "I-ABC",
        planId: "P-PLAN",
        record: {},
      });

      expect(result.deferred).toBe(true);
      expect(sent).toHaveLength(0);
      // Nothing claimed, so the next attempt can still send it properly.
      expect(await CustomerMessage.countDocuments({})).toBe(0);
    });
  });

  describe("the annual reminder", () => {
    it("goes out once per anniversary year", async () => {
      const user = await subscriber();

      await sendAnnualRenewalReminder({ user, subscriptionId: "I-ABC", year: 1, record: {} });
      await sendAnnualRenewalReminder({ user, subscriptionId: "I-ABC", year: 1, record: {} });
      await sendAnnualRenewalReminder({ user, subscriptionId: "I-ABC", year: 2, record: {} });

      expect(sent).toHaveLength(2);
    });

    it("is not sent at all while the feature is switched off", async () => {
      const user = await subscriber();
      await PaypalSubscription.create({
        subscription_id: "I-OLD",
        user_id: user._id,
        activated_at: new Date(Date.now() - 400 * DAY),
      });

      const result = await sendDueAnnualReminders();

      expect(result.skipped).toBe("disabled");
      expect(sent).toHaveLength(0);
    });

    it("reaches a subscriber past their first year once switched on", async () => {
      process.env.CUSTOMER_ANNUAL_REMINDER_ENABLED = "true";
      try {
        const user = await subscriber();
        await PaypalSubscription.create({
          subscription_id: "I-OLD",
          user_id: user._id,
          activated_at: new Date(Date.now() - 400 * DAY),
          next_billing_time: new Date(Date.now() + 10 * DAY),
        });

        const result = await sendDueAnnualReminders();

        expect(result.sent).toBe(1);
        expect(flat(sent[0].text)).toContain("annual reminder");
        expect(flat(sent[0].text)).toContain("Cancel Subscription");
      } finally {
        delete process.env.CUSTOMER_ANNUAL_REMINDER_ENABLED;
      }
    });

    it("skips a subscriber who has already cancelled", async () => {
      process.env.CUSTOMER_ANNUAL_REMINDER_ENABLED = "true";
      try {
        const user = await subscriber();
        await PaypalSubscription.create({
          subscription_id: "I-GONE",
          user_id: user._id,
          activated_at: new Date(Date.now() - 400 * DAY),
          cancelled_at: new Date(),
        });

        const result = await sendDueAnnualReminders();

        expect(result.examined).toBe(0);
        expect(sent).toHaveLength(0);
      } finally {
        delete process.env.CUSTOMER_ANNUAL_REMINDER_ENABLED;
      }
    });
  });

  describe("notice periods are enforced where they cannot be skipped", () => {
    it("refuses a price change with less than thirty days' notice", async () => {
      const user = await subscriber();

      await expect(
        sendPriceChangeNotice({
          user,
          subscriptionId: "I-ABC",
          currentPrice: "USD 6.00/month",
          newPrice: "USD 7.00/month",
          effectiveAt: new Date(Date.now() + 10 * DAY),
          key: "too-soon",
        })
      ).rejects.toThrow(/30 days/);

      expect(sent).toHaveLength(0);
    });

    it("accepts one with thirty-one days, and says what happens if you do nothing", async () => {
      const user = await subscriber();

      await sendPriceChangeNotice({
        user,
        subscriptionId: "I-ABC",
        currentPrice: "USD 6.00/month",
        newPrice: "USD 7.00/month",
        effectiveAt: new Date(Date.now() + 31 * DAY),
        key: "increase",
      });

      expect(flat(sent[0].text)).toContain("USD 7.00/month");
      expect(flat(sent[0].text)).toContain("cancel before then");
      expect(flat(sent[0].text)).toContain("continues at the new price");
    });

    it("refuses a terms change with less than thirty days' notice", async () => {
      const user = await subscriber();

      await expect(
        sendTermsChangeNotice({
          user,
          version: "2026-10-01.1",
          effectiveAt: new Date(Date.now() + 5 * DAY),
          summary: "Anything.",
        })
      ).rejects.toThrow(/30 days/);
    });
  });

  describe("nothing here is marketing", () => {
    it("tells the recipient why they got it and offers no unsubscribe", async () => {
      const user = await subscriber();
      await sendAnnualRenewalReminder({ user, subscriptionId: "I-ABC", year: 1, record: {} });

      expect(flat(sent[0].text)).toContain("no marketing list to unsubscribe from");
      expect(flat(sent[0].text)).toContain("FaceStream Corporation");
    });
  });

  describe("a failed send", () => {
    it("stays pending and is retried, not lost", async () => {
      const user = await subscriber();
      await PaypalSubscription.create({
        subscription_id: "I-ABC",
        user_id: user._id,
        plan_id: "P-PLAN",
      });

      sendMail.mockRejectedValueOnce(new Error("provider down"));

      const first = await sendEnrollmentConfirmation({
        user,
        subscriptionId: "I-ABC",
        planId: "P-PLAN",
        record: {},
      });
      expect(first.sent).toBe(false);

      const row = await CustomerMessage.findOne({ key: "I-ABC" });
      expect(row.status).toBe("pending");
      expect(row.last_error).toContain("provider down");

      const retry = await retryPendingMessages();

      expect(retry.sent).toBe(1);
      expect((await CustomerMessage.findOne({ key: "I-ABC" })).status).toBe("sent");
    });

    it("gives up on a message whose recipient no longer exists", async () => {
      const user = await subscriber();
      sendMail.mockRejectedValueOnce(new Error("provider down"));

      await sendEnrollmentConfirmation({
        user,
        subscriptionId: "I-NOWHERE",
        planId: "P-PLAN",
        record: {},
      });
      await User.deleteOne({ _id: user._id });

      await retryPendingMessages();

      expect((await CustomerMessage.findOne({ key: "I-NOWHERE" })).status).toBe("failed");
    });

    it("leaves a price change for a person rather than guessing its figures", async () => {
      const user = await subscriber();
      sendMail.mockRejectedValueOnce(new Error("provider down"));

      await sendPriceChangeNotice({
        user,
        subscriptionId: "I-ABC",
        currentPrice: "USD 6.00/month",
        newPrice: "USD 7.00/month",
        effectiveAt: new Date(Date.now() + 31 * DAY),
        key: "increase",
      });

      const retry = await retryPendingMessages();

      expect(retry.sent).toBe(0);
      expect(retry.needsAPerson).toEqual([
        { kind: MessageKind.priceChange, key: "I-ABC:increase" },
      ]);
    });
  });
});
