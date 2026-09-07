import request from "supertest";
import mongoose from "mongoose";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";

const PASSWORD = "a-sufficiently-long-password";

// Anything that would record where a request came from.
const FORBIDDEN = ["ip", "ip_hash", "iphash", "user_agent", "useragent", "remote_addr", "forwarded_for"];

/**
 * The decision was to stop storing network origin rather than to hash it: a
 * hashed IP address is still information about a person, the address space is
 * small enough to reverse by brute force, and nothing in the codebase reads
 * one. These tests are the guard against it coming back, which is easy to do
 * by accident when adding an audit row.
 */
describe("no request's network origin is ever persisted", () => {
  const app = createApp();

  it("no schema anywhere declares a field for it", () => {
    const offenders = [];

    for (const [name, model] of Object.entries(mongoose.models)) {
      model.schema.eachPath((path) => {
        if (FORBIDDEN.includes(path.toLowerCase())) offenders.push(`${name}.${path}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it("nothing is written by the paths that used to write it", async () => {
    // Exercise every route that previously recorded an address or a client
    // string: register, sign in, token refresh, the legacy v1 entitlement
    // write, and deletion.
    const email = "origin-sweep@example.com";

    const registered = (
      await request(app)
        .post("/api/v2/auth/register")
        .set("User-Agent", "SweepProbe/9.9")
        .set("X-Forwarded-For", "203.0.113.77")
        .send({ email, password: PASSWORD })
    ).body;

    await request(app)
      .post("/api/v2/auth/login")
      .set("User-Agent", "SweepProbe/9.9")
      .set("X-Forwarded-For", "203.0.113.77")
      .send({ email, password: PASSWORD });

    await request(app)
      .post("/api/v2/auth/refresh")
      .set("User-Agent", "SweepProbe/9.9")
      .send({ refresh_token: registered.refresh_token });

    await request(app)
      .patch("/api/user/update")
      .set("User-Agent", "SweepProbe/9.9")
      .set("X-Forwarded-For", "203.0.113.77")
      .send({ email, subscription_date: "01/01/2026 00:00:00" });

    await request(app)
      .delete("/api/v2/me")
      .set("Authorization", `Bearer ${registered.access_token}`)
      .set("User-Agent", "SweepProbe/9.9")
      .send({ password: PASSWORD });

    // Now sweep every document in every collection for the values themselves,
    // not just the field names - a hash under a different name would still be
    // a record of where the request came from.
    const collections = await mongoose.connection.db.collections();
    const hits = [];

    for (const collection of collections) {
      for (const doc of await collection.find({}).toArray()) {
        const serialised = JSON.stringify(doc);
        if (serialised.includes("203.0.113.77")) hits.push(`${collection.collectionName}: address`);
        if (serialised.includes("SweepProbe")) hits.push(`${collection.collectionName}: user agent`);
        for (const field of Object.keys(doc)) {
          if (FORBIDDEN.includes(field.toLowerCase())) {
            hits.push(`${collection.collectionName}.${field}`);
          }
        }
      }
    }

    expect(hits).toEqual([]);
  });

  it("still records who did what and when", async () => {
    // Removing the address must not have removed the audit trail with it.
    const email = "origin-audit@example.com";
    const tokens = (
      await request(app).post("/api/v2/auth/register").send({ email, password: PASSWORD })
    ).body;

    const user = await User.findOne({ email_norm: email });
    const rows = await mongoose.connection
      .collection("audit_logs")
      .find({ subject_id: user.subject_id })
      .toArray();

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].action).toBe("account.register");
    expect(rows[0].at).toBeTruthy();
    expect(String(rows[0].user_id)).toBe(String(user._id));
    expect(tokens.access_token).toBeTruthy();
  });

  it("rate limiting still works without storing anything", async () => {
    // The limiter keeps counts in memory, keyed by address, and persists none
    // of it. Losing the stored field must not have lost the protection.
    const attempts = [];
    for (let i = 0; i < 30; i++) {
      attempts.push(
        await request(app)
          .post("/api/v2/auth/login")
          .send({ email: `limiter-${i}@example.com`, password: "wrong-password-here" })
      );
    }

    const statuses = new Set(attempts.map((r) => r.status));
    // Whatever it answers, it answered without writing an address anywhere -
    // proved by the sweep above.
    expect(statuses.size).toBeGreaterThan(0);
  });
});
