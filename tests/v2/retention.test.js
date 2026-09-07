import mongoose from "mongoose";
import { CancellationFeedback } from "../../src/models/cancellationFeedback";
import { AuditLog } from "../../src/models/auditLog";
import { purgeExpiredRecords } from "../../src/v2/services/maintenanceService";
import { config } from "../../src/config/env";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Retention that is only written in a privacy notice is not retention. These
 * check that the periods the notice states are the periods a job enforces.
 */
describe("retention is enforced, not merely stated", () => {
  afterEach(async () => {
    await CancellationFeedback.deleteMany({});
    await AuditLog.deleteMany({});
  });

  describe("cancellation feedback", () => {
    it("is kept for twelve months", () => {
      expect(config.retention.cancellationFeedbackDays).toBe(365);
    });

    it("is deleted once the period has passed", async () => {
      await CancellationFeedback.create({
        subject_id: "sub_old",
        reason_code: "too_expensive",
        comment: "A year and a day ago.",
        at: new Date(Date.now() - 366 * DAY),
      });

      const result = await purgeExpiredRecords();

      expect(result.cancellation_feedback).toBe(1);
      expect(await CancellationFeedback.findOne({ subject_id: "sub_old" })).toBeNull();
    });

    it("is kept while it is still inside the period", async () => {
      await CancellationFeedback.create({
        subject_id: "sub_recent",
        reason_code: "not_using_it",
        at: new Date(Date.now() - 30 * DAY),
      });

      await purgeExpiredRecords();

      expect(await CancellationFeedback.findOne({ subject_id: "sub_recent" })).toBeTruthy();
    });

    it("takes the free text with it, not just the row's reason code", async () => {
      await CancellationFeedback.create({
        subject_id: "sub_text",
        comment: "Something a person typed about why they left.",
        at: new Date(Date.now() - 400 * DAY),
      });

      await purgeExpiredRecords();

      const remaining = await mongoose.connection
        .collection("cancellation_feedbacks")
        .find({})
        .toArray();
      expect(JSON.stringify(remaining)).not.toContain("Something a person typed");
    });
  });

  describe("the periods the Privacy Notice states", () => {
    it("matches audit records at one year", () => {
      expect(config.retention.auditLogDays).toBe(365);
    });

    it("matches financial records at seven years", () => {
      // 2555 days is seven years, which is what the notice says.
      expect(config.retention.financialRecordDays).toBe(2555);
      expect(Math.round(config.retention.financialRecordDays / 365)).toBe(7);
    });

    it("actually deletes audit records past their period", async () => {
      await AuditLog.create({
        action: "account.register",
        subject_id: "sub_stale",
        at: new Date(Date.now() - 400 * DAY),
      });

      const result = await purgeExpiredRecords();

      expect(result.audit_logs).toBeGreaterThanOrEqual(1);
      expect(await AuditLog.findOne({ subject_id: "sub_stale" })).toBeNull();
    });
  });
});
