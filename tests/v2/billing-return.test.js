import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

/**
 * The approval round trip lands in a browser that has no app session, so these
 * pages must answer without authentication and must not decide anything.
 */
describe("PayPal approval landing pages", () => {
  it("serves a success page telling the user to return to the app", async () => {
    const res = await request(app).get("/api/v2/billing/return");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toMatch(/approved/i);
    expect(res.text).toMatch(/AICONTACT/);
  });

  it("serves a cancellation page that makes clear nothing was charged", async () => {
    const res = await request(app).get("/api/v2/billing/cancel");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/nothing has been charged/i);
  });

  it("does not require a bearer token", async () => {
    // 401 here would strand every returning subscriber on an error page.
    for (const path of ["/api/v2/billing/return", "/api/v2/billing/cancel"]) {
      const res = await request(app).get(path);
      expect(res.status).not.toBe(401);
    }
  });

  it("uses no custom URI scheme, so no deep link can silently fail", async () => {
    const res = await request(app).get("/api/v2/billing/return");
    expect(res.text).not.toMatch(/aicontact:\/\//);
  });

  it("grants nothing by itself - entitlement still comes from the server", async () => {
    const res = await request(app).get("/api/v2/billing/return");
    expect(res.text).not.toMatch(/entitle|subscription_id|access_token/i);
  });
});
