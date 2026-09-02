import request from "supertest";
import { createApp } from "../../src/app";
import { User } from "../../src/models/user";
import { EntitlementAudit } from "../../src/models/entitlementAudit";

const app = createApp();
const PASSWORD = "correct-horse-battery";

describe("registration input handling", () => {
  it("ignores a client-supplied subscription_date", async () => {
    // The original passed the raw body to User.create, so a client could
    // grant itself a paid entitlement at signup.
    const res = await request(app).post("/api/user/register").send({
      email: "massassign@example.com",
      password: PASSWORD,
      subscription_date: "01/01/2099 00:00:00",
      terms_accepted: "false",
    });

    expect(res.status).toBe(200);
    expect(res.body.user.subscription_date).toBe("");

    const stored = await User.findOne({ email: "massassign@example.com" });
    expect(stored.subscription_date).toBe("");
  });

  it("ignores unknown fields entirely", async () => {
    const res = await request(app).post("/api/user/register").send({
      email: "extra@example.com",
      password: PASSWORD,
      terms_accepted: "false",
      isAdmin: true,
      _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(res.status).toBe(200);
    expect(res.body.user).not.toHaveProperty("isAdmin");
    expect(res.body.user._id).not.toBe("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("rejects a short password", async () => {
    const res = await request(app)
      .post("/api/user/register")
      .send({ email: "short@example.com", password: "abc", terms_accepted: "false" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed email", async () => {
    const res = await request(app)
      .post("/api/user/register")
      .send({ email: "not-an-email", password: PASSWORD, terms_accepted: "false" });
    expect(res.status).toBe(400);
  });

  it("survives a body with no fields at all", async () => {
    const res = await request(app).post("/api/user/register").send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("status", "Error");
  });
});

describe("email casing", () => {
  const MIXED = "Casing.Test@Example.com";

  beforeAll(async () => {
    await request(app)
      .post("/api/user/register")
      .send({ email: MIXED, password: PASSWORD, terms_accepted: "false" });
  });

  it("refuses a case-variant duplicate", async () => {
    const res = await request(app)
      .post("/api/user/register")
      .send({ email: "casing.test@example.com", password: PASSWORD, terms_accepted: "false" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Email address already exists!");
  });

  it("finds the account regardless of the casing requested", async () => {
    const res = await request(app).get(
      `/api/user/${encodeURIComponent("CASING.TEST@EXAMPLE.COM")}`
    );
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(MIXED);
  });

  it("signs in regardless of casing", async () => {
    const res = await request(app)
      .post("/api/user/login")
      .send({ email: "casing.test@example.com", password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe("login", () => {
  it("gives an identical answer for an unknown account and a wrong password", async () => {
    const unknown = await request(app)
      .post("/api/user/login")
      .send({ email: "ghost@example.com", password: PASSWORD });
    const wrong = await request(app)
      .post("/api/user/login")
      .send({ email: "massassign@example.com", password: "wrong-password" });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("survives a non-string password", async () => {
    const res = await request(app)
      .post("/api/user/login")
      .send({ email: "massassign@example.com", password: { $ne: null } });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid credentials");
  });
});

describe("entitlement writes", () => {
  it("records an audit row for every subscription_date write", async () => {
    await EntitlementAudit.deleteMany({});

    const res = await request(app).patch("/api/user/update").send({
      email: "massassign@example.com",
      password: null,
      subscription_date: "02/02/2026 12:00:00",
      terms_accepted: null,
    });

    expect(res.status).toBe(200);
    const audits = await EntitlementAudit.find({});
    expect(audits).toHaveLength(1);
    expect(audits[0].next_subscription_date).toBe("02/02/2026 12:00:00");
    expect(audits[0].previous_subscription_date).toBe("");
  });

  it("does not audit a terms-only update", async () => {
    await EntitlementAudit.deleteMany({});

    await request(app).patch("/api/user/update").send({
      email: "massassign@example.com",
      password: null,
      subscription_date: null,
      terms_accepted: "true",
    });

    expect(await EntitlementAudit.countDocuments({})).toBe(0);
  });

  it("rejects an update that sets nothing", async () => {
    // Unreachable in the original: it compared against null only, and absent
    // JSON fields arrive as undefined, so the branch never ran.
    const res = await request(app).patch("/api/user/update").send({
      email: "massassign@example.com",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("No valid fields to update.");
  });
});

describe("password hash exposure", () => {
  it("is absent from every response shape", async () => {
    const responses = await Promise.all([
      request(app).get("/api/user/massassign%40example.com"),
      request(app).patch("/api/user/update").send({
        email: "massassign@example.com",
        subscription_date: null,
        terms_accepted: "true",
      }),
    ]);

    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
      expect(res.body.user).not.toHaveProperty("password");
    }
  });

  it("is still stored, and still verifies", async () => {
    const stored = await User.findOne({ email: "massassign@example.com" });
    expect(stored.password).toMatch(/^\$2[aby]\$/);
  });
});

describe("operational endpoints", () => {
  it("reports liveness", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("reports readiness from the database connection", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("sets the API version header", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-api-version"]).toBe("1");
  });
});
