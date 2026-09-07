import mongoose from "mongoose";
import { User } from "../../src/models/user";
import { PaypalSubscription } from "../../src/models/paypalSubscription";
import { PendingCancellation } from "../../src/models/pendingCancellation";
import { WeeklyReport } from "../../src/models/weeklyReport";
import * as ownerNotifier from "../../src/v2/services/ownerNotifier";
import {
  deliverWeeklyReport,
  collectCounts,
  reportBody,
  reportSubject,
} from "../../src/v2/services/weeklyReportService";
import { weeklyWindow } from "../../src/v2/services/reportWindow";

// A Thursday, so the completed week runs Mon 5 Jan 09:00 to Mon 12 Jan 09:00
// New York.
const NOW = new Date("2026-01-15T20:00:00Z");
const WINDOW = weeklyWindow(NOW);
const IN_WINDOW = new Date(WINDOW.start.getTime() + 2 * 24 * 60 * 60 * 1000);
const BEFORE_WINDOW = new Date(WINDOW.start.getTime() - 3 * 24 * 60 * 60 * 1000);
const AFTER_WINDOW = new Date(WINDOW.end.getTime() + 60 * 1000);

const idAt = (date, nudge = 0) =>
  mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000) + nudge);

const seedUser = async (date, nudge, extra = {}) =>
  User.create({
    _id: idAt(date, nudge),
    email: `seed-${date.getTime()}-${nudge}@example.com`,
    email_norm: `seed-${date.getTime()}-${nudge}@example.com`,
    password: "hashed",
    subject_id: `subject-${date.getTime()}-${nudge}`,
    ...extra,
  });

describe("the weekly owner tally", () => {
  let notify;

  beforeAll(async () => {
    process.env.WEEKLY_REPORT_ENABLED = "true";
    process.env.OWNER_REPORT_TRANSPORT = "mail";
    process.env.OWNER_REPORT_TO = "owner@example.invalid";

    // Registrations: two inside the window, one before it, one after.
    await seedUser(IN_WINDOW, 0);
    await seedUser(IN_WINDOW, 1);
    await seedUser(BEFORE_WINDOW, 0);
    await seedUser(AFTER_WINDOW, 0);

    // One of the accounts inside the window was later deleted.
    await seedUser(BEFORE_WINDOW, 5, { status: "deleted", deleted_at: IN_WINDOW });
    // And one deleted outside it.
    await seedUser(BEFORE_WINDOW, 6, { status: "deleted", deleted_at: BEFORE_WINDOW });

    await PaypalSubscription.create([
      // Approved during the week and still billing, on the paid plan.
      {
        subscription_id: "I-WR-PAID-0001",
        status: "ACTIVE",
        phase: "paid",
        activated_at: IN_WINDOW,
      },
      // Approved during the week, still in its trial.
      {
        subscription_id: "I-WR-TRIAL-001",
        status: "ACTIVE",
        phase: "trial",
        activated_at: IN_WINDOW,
      },
      // Approved before the week: counts as an active subscriber, not a new one.
      {
        subscription_id: "I-WR-OLD-0001",
        status: "ACTIVE",
        phase: "paid",
        activated_at: BEFORE_WINDOW,
      },
      // Cancelled during the week.
      {
        subscription_id: "I-WR-CANC-0001",
        status: "CANCELLED",
        phase: "paid",
        activated_at: BEFORE_WINDOW,
        cancelled_at: IN_WINDOW,
      },
      // Cancelled after the window closed: next week's business.
      {
        subscription_id: "I-WR-CANC-0002",
        status: "CANCELLED",
        phase: "paid",
        activated_at: BEFORE_WINDOW,
        cancelled_at: AFTER_WINDOW,
      },
      // Linked before the phase was recorded.
      { subscription_id: "I-WR-UNKNOWN01", status: "ACTIVE", activated_at: BEFORE_WINDOW },
    ]);

    await PendingCancellation.create({
      subscription_id: "I-WR-STUCK-001",
      subject_id: "subject-stuck",
      attempts: 3,
      last_attempt_at: IN_WINDOW,
      last_error: "cancel returned 500",
    });
  });

  beforeEach(() => {
    notify = jest
      .spyOn(ownerNotifier, "notifyOwner")
      .mockResolvedValue({ delivered: true, adapter: "test" });
  });

  afterEach(async () => {
    notify.mockRestore();
    await WeeklyReport.deleteMany({});
  });

  describe("counting", () => {
    it("counts only what happened inside the reporting window", async () => {
      const counts = await collectCounts(WINDOW);

      expect(counts.registrations).toBe(2);
      expect(counts.subscriptions_approved).toBe(2);
      expect(counts.subscriptions_cancelled).toBe(1);
      expect(counts.accounts_deleted).toBe(1);
    });

    it("reports current subscribers, not window subscribers", async () => {
      const counts = await collectCounts(WINDOW);

      expect(counts.active_trials).toBe(1);
      expect(counts.active_paid).toBe(2);
      // Reported on its own rather than folded into either bucket.
      expect(counts.active_phase_unknown).toBe(1);
    });

    it("nets approvals against cancellations", async () => {
      const counts = await collectCounts(WINDOW);
      expect(counts.net_subscriber_change).toBe(
        counts.subscriptions_approved - counts.subscriptions_cancelled
      );
      expect(counts.net_subscriber_change).toBe(1);
    });

    it("surfaces cancellations PayPal has not confirmed", async () => {
      const counts = await collectCounts(WINDOW);
      expect(counts.cancellations_unresolved).toBe(1);
      expect(counts.cancellation_attempts_failed).toBe(1);
    });

    it("uses a different window for a different week", async () => {
      const earlier = weeklyWindow(new Date(WINDOW.start.getTime() - 60 * 1000));
      const counts = await collectCounts(earlier);
      expect(counts.registrations).toBe(0);
      expect(counts.subscriptions_approved).toBe(0);
    });
  });

  describe("delivery", () => {
    it("sends one summary rather than one message per event", async () => {
      const result = await deliverWeeklyReport({ now: NOW });

      expect(result.sent).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0].subject).toContain("weekly billing summary");
    });

    it("records the covered range and the delivery status", async () => {
      await deliverWeeklyReport({ now: NOW });

      const stored = await WeeklyReport.findOne({});
      expect(stored.period_start.getTime()).toBe(WINDOW.start.getTime());
      expect(stored.period_end.getTime()).toBe(WINDOW.end.getTime());
      expect(stored.status).toBe("sent");
      expect(stored.sent_at).toBeTruthy();
      expect(stored.counts.registrations).toBe(2);
    });

    it("does not send the same week twice when the job runs again", async () => {
      await deliverWeeklyReport({ now: NOW });
      const second = await deliverWeeklyReport({ now: NOW });

      expect(second.skipped).toBe("already_delivered_or_in_flight");
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await WeeklyReport.countDocuments({})).toBe(1);
    });

    it("does not send twice when the job runs at a different point in the week", async () => {
      // A restart, a second process, a manual run: every instant in the week
      // resolves to the same window and therefore the same stored report.
      await deliverWeeklyReport({ now: NOW });
      await deliverWeeklyReport({ now: new Date(NOW.getTime() + 6 * 60 * 60 * 1000) });

      expect(notify).toHaveBeenCalledTimes(1);
      expect(await WeeklyReport.countDocuments({})).toBe(1);
    });

    it("survives two runs racing each other", async () => {
      await Promise.all([
        deliverWeeklyReport({ now: NOW }),
        deliverWeeklyReport({ now: NOW }),
        deliverWeeklyReport({ now: NOW }),
      ]);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(await WeeklyReport.countDocuments({})).toBe(1);
    });

    it("keeps an undelivered report and retries it", async () => {
      notify.mockRejectedValueOnce(new Error("smtp unavailable"));

      const failed = await deliverWeeklyReport({ now: NOW });
      expect(failed.failed).toBe(true);

      const afterFailure = await WeeklyReport.findOne({});
      expect(afterFailure.status).toBe("failed");
      expect(afterFailure.last_error).toContain("smtp unavailable");
      // Retained, not discarded.
      expect(afterFailure.counts.registrations).toBe(2);

      const retried = await deliverWeeklyReport({ now: NOW });
      expect(retried.sent).toBe(true);

      const afterRetry = await WeeklyReport.findOne({});
      expect(afterRetry.status).toBe("sent");
      expect(afterRetry.attempts).toBe(2);
      // Still one report for the week, delivered once.
      expect(await WeeklyReport.countDocuments({})).toBe(1);
      expect(notify).toHaveBeenCalledTimes(2);
    });

    it("does not mark a week sent when the adapter did not actually send it", async () => {
      // The default "log" adapter writes a line and returns delivered: false.
      // Believing it would lose the week permanently and silently: the window
      // never comes round again, so nobody would find out it never arrived.
      notify.mockResolvedValueOnce({ delivered: false, adapter: "log" });

      const result = await deliverWeeklyReport({ now: NOW });

      expect(result.sent).toBeFalsy();
      expect(result.failed).toBe(true);

      const stored = await WeeklyReport.findOne({});
      expect(stored.status).toBe("failed");
      expect(stored.last_error).toContain("did not deliver");
      // And it names the fix.
      expect(stored.last_error).toContain("OWNER_REPORT_TRANSPORT");
    });

    it("delivers the week that a non-sending adapter left behind", async () => {
      notify.mockResolvedValueOnce({ delivered: false, adapter: "log" });
      await deliverWeeklyReport({ now: NOW });

      const retried = await deliverWeeklyReport({ now: NOW });

      expect(retried.sent).toBe(true);
      expect((await WeeklyReport.findOne({})).status).toBe("sent");
      expect(await WeeklyReport.countDocuments({})).toBe(1);
    });

    it("sends nothing when it has not been switched on", async () => {
      process.env.WEEKLY_REPORT_ENABLED = "false";
      const result = await deliverWeeklyReport({ now: NOW });
      process.env.WEEKLY_REPORT_ENABLED = "true";

      expect(result.skipped).toBe("disabled");
      expect(notify).not.toHaveBeenCalled();
      expect(await WeeklyReport.countDocuments({})).toBe(0);
    });

    it("sends nothing when no recipient is configured", async () => {
      process.env.OWNER_REPORT_TO = "";
      const result = await deliverWeeklyReport({ now: NOW });
      process.env.OWNER_REPORT_TO = "owner@example.invalid";

      expect(result.skipped).toBe("no_recipient");
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("what the summary says", () => {
    it("is recognisable as a business summary, not an alarm", async () => {
      const subject = reportSubject(WINDOW);
      expect(subject).toContain("weekly billing summary");
      expect(subject).not.toContain("ALARM");
    });

    it("carries counts and no personal information", async () => {
      const counts = await collectCounts(WINDOW);
      const body = reportBody(WINDOW, counts);

      expect(body).toContain("New registrations");
      expect(body).toContain("Active trials");
      expect(body).toContain("Net subscriber change");

      // Nothing that identifies anybody, and no credentials of any kind.
      expect(body).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(body).not.toContain("I-WR-");
      expect(body).not.toContain("subject-");
      expect(body.toLowerCase()).not.toContain("token");
      expect(body.toLowerCase()).not.toContain("password");
      expect(body.toLowerCase()).not.toContain("client_secret");
    });
  });
});
