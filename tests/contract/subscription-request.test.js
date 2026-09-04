import request from "supertest";
import { createApp } from "../../src/app";

/**
 * The shipped client posts an empty body. This is the contract that broke in
 * the sandbox run - the endpoint demanded plan_id and returned 400, so the
 * trial call to action failed for every user.
 */
describe("POST /api/v2/entitlements/paypal/subscription request shape", () => {
  const app = createApp();

  it("does not reject an empty body for a missing plan_id", async () => {
    const res = await request(app)
      .post("/api/v2/entitlements/paypal/subscription")
      .send({});

    // Unauthenticated here, so 401 is expected. What must never come back is
    // the validation failure that the client hit in sandbox.
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/plan_id must be a string/);
  });

  it("treats a body-less request the same as an empty object", async () => {
    const res = await request(app).post("/api/v2/entitlements/paypal/subscription");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/plan_id/);
  });
});
