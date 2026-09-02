import request from "supertest";
import { createApp } from "../../src/app";
import { AuditLog } from "../../src/models/auditLog";
import { Entitlement } from "../../src/models/entitlement";
import { AppleTransaction } from "../../src/models/appleTransaction";
import { PendingCancellation } from "../../src/models/pendingCancellation";
import {
  purgeExpiredRecords,
  retryPendingCancellations,
} from "../../src/v2/services/maintenanceService";
import { resetTokenCache } from "../../src/v2/services/paypalService";
import { paypalSubscription, installFetchStub, paypalAuthRoute, DAY } from "../helpers/providers";

const app = createApp();
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  resetTokenCache();
  process.env.CORS_ALLOWED_ORIGINS = "";
});

describe("retention is enforced, not just configured", () => {
  it("deletes audit rows past the configured window", async () => {
    process.env.RETENTION_AUDIT_DAYS = "30";

    const old = await AuditLog.create({
      action: "account.register",
      subject_id: "sub_retention_old",
      at: new Date(Date.now() - 400 * DAY),
    });
    const recent = await AuditLog.create({
      action: "account.register",
      subject_id: "sub_retention_new",
      at: new Date(Date.now() - DAY),
    });

    const result = await purgeExpiredRecords();

    expect(result.audit_logs).toBeGreaterThanOrEqual(1);
    expect(await AuditLog.findById(old._id)).toBeNull();
    expect(await AuditLog.findById(recent._id)).toBeTruthy();
  });

  it("deletes detached financial records past the configured window", async () => {
    process.env.RETENTION_FINANCIAL_DAYS = "365";

    const old = await Entitlement.create({
      subject_id: "sub_fin_old",
      platform: "apple",
      status: "revoked",
      created_at: new Date(Date.now() - 900 * DAY),
      updated_at: new Date(Date.now() - 900 * DAY),
    });
    const recent = await Entitlement.create({
      subject_id: "sub_fin_new",
      platform: "paypal",
      status: "revoked",
      created_at: new Date(Date.now() - 10 * DAY),
      updated_at: new Date(Date.now() - 10 * DAY),
    });

    await purgeExpiredRecords();

    expect(await Entitlement.findById(old._id)).toBeNull();
    expect(await Entitlement.findById(recent._id)).toBeTruthy();
  });

  it("never deletes records still attached to a live account", async () => {
    process.env.RETENTION_FINANCIAL_DAYS = "1";

    const mongoose = require("mongoose");
    const attached = await AppleTransaction.create({
      original_transaction_id: "RETAIN00000001",
      user_id: new mongoose.Types.ObjectId(),
      updated_at: new Date(Date.now() - 900 * DAY),
    });

    await purgeExpiredRecords();

    expect(await AppleTransaction.findById(attached._id)).toBeTruthy();

    process.env.RETENTION_FINANCIAL_DAYS = "2555";
  });
});

describe("pending cancellations are retried", () => {
  it("resolves a job once PayPal confirms the subscription stopped", async () => {
    await PendingCancellation.create({
      subscription_id: "I-RETRYJOB0001",
      subject_id: "sub_retry_1",
      reason: "account deletion",
      attempts: 1,
    });

    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": (url) =>
        String(url).endsWith("/cancel")
          ? { status: 204, body: {} }
          : { body: paypalSubscription({ id: "I-RETRYJOB0001", status: "CANCELLED" }) },
    });

    const result = await retryPendingCancellations();

    expect(result.resolved).toBeGreaterThanOrEqual(1);
    const job = await PendingCancellation.findOne({ subscription_id: "I-RETRYJOB0001" });
    expect(job.resolved_at).toBeTruthy();
  });

  it("leaves the job open when PayPal still reports it active", async () => {
    await PendingCancellation.create({
      subscription_id: "I-RETRYJOB0002",
      subject_id: "sub_retry_2",
      reason: "account deletion",
    });

    installFetchStub({
      ...paypalAuthRoute,
      "/v1/billing/subscriptions/": (url) =>
        String(url).endsWith("/cancel")
          ? { status: 500, body: {} }
          : { body: paypalSubscription({ id: "I-RETRYJOB0002", status: "ACTIVE" }) },
    });

    await retryPendingCancellations();

    const job = await PendingCancellation.findOne({ subscription_id: "I-RETRYJOB0002" });
    expect(job.resolved_at).toBeFalsy();
    expect(job.attempts).toBeGreaterThanOrEqual(1);
  });
});

describe("CORS", () => {
  it("does not echo an arbitrary origin on v2", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://app.facestream.ai";

    const res = await request(app)
      .get("/api/v2/me")
      .set("Origin", "https://attacker.example.com");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows an origin on the allowlist", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://app.facestream.ai";

    const res = await request(app)
      .get("/api/v2/me")
      .set("Origin", "https://app.facestream.ai");

    expect(res.headers["access-control-allow-origin"]).toBe("https://app.facestream.ai");
  });

  it("still serves native clients, which send no Origin at all", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://app.facestream.ai";

    const res = await request(app).get("/api/v2/me");
    expect(res.status).toBe(401);
  });

  it("leaves v1 permissive for the released clients", async () => {
    const res = await request(app)
      .get("/api/user/nobody%40example.com")
      .set("Origin", "https://anything.example.com");

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("request body limits", () => {
  const bodyOfSize = (bytes) => ({ email: "a@example.com", padding: "x".repeat(bytes) });

  it("rejects an oversized body on an unauthenticated auth route", async () => {
    // 50MB on an unauthenticated endpoint is free memory pressure for anyone
    // who wants it.
    const res = await request(app)
      .post("/api/v2/auth/login")
      .set("Content-Type", "application/json")
      .send(bodyOfSize(2 * 1024 * 1024));

    expect(res.status).toBe(413);
  });

  it("rejects an oversized body on v1 too", async () => {
    const res = await request(app)
      .post("/api/user/login")
      .set("Content-Type", "application/json")
      .send(bodyOfSize(2 * 1024 * 1024));

    expect(res.status).toBe(413);
  });

  it("still accepts a normal request", async () => {
    const res = await request(app)
      .post("/api/v2/auth/login")
      .send({ email: "someone@example.com", password: "a-normal-password" });

    expect(res.status).toBe(401);
  });

  it("accepts a signed Apple transaction, which is larger than a normal body", async () => {
    const res = await request(app)
      .post("/api/v2/entitlements/apple/verify")
      .send({ signed_transaction: "x".repeat(30 * 1024) });

    // Unauthenticated, so 401 - but it must not have been rejected for size.
    expect(res.status).toBe(401);
  });
});
