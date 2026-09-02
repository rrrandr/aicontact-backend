import request from "supertest";
import { createApp } from "../../src/app";
import { config } from "../../src/config/env";
import { resetThrottle } from "../../src/middlewears/throttle";

// Its own file so it gets a fresh module registry, and therefore a fresh
// rate-limiter instance, rather than inheriting counts from other suites.
const app = createApp();

describe("auth endpoints reject when limited", () => {
  it("returns 429 once the ceiling is passed", async () => {
    const attempts = config.rateLimit.authMax + 1;
    let last;

    for (let i = 0; i < attempts; i += 1) {
      last = await request(app)
        .post("/api/user/login")
        .send({ email: `unknown${i}@example.com`, password: "whatever-long" });
    }

    expect(last.status).toBe(429);
    expect(last.body.status).toBe("Error");
  });
});

describe("retry-prone endpoints do not reject", () => {
  // GET and PATCH share one per-client bucket by design, so each case starts
  // from a clean window rather than inheriting the previous one's count.
  beforeEach(() => resetThrottle());

  it("never answers GET with 429 at volumes that would limit auth", async () => {
    // The asymmetry is the whole point. A 429 here would put every installed
    // app into a hot loop, because the client's failure handler re-issues the
    // request immediately and forever.
    const volume = config.rateLimit.authMax * 3;

    for (let i = 0; i < volume; i += 1) {
      const res = await request(app).get("/api/user/nobody%40example.com");
      expect(res.status).not.toBe(429);
    }
  });

  it("never answers PATCH with 429 at the same volume", async () => {
    const volume = config.rateLimit.authMax * 3;

    for (let i = 0; i < volume; i += 1) {
      const res = await request(app)
        .patch("/api/user/update")
        .send({ email: "nobody@example.com", subscription_date: "x", terms_accepted: null });
      expect(res.status).not.toBe(429);
    }
  });
});

describe("throttle applies backpressure before it ever rejects", () => {
  beforeEach(() => resetThrottle());

  it("slows down past the threshold instead of failing", async () => {
    for (let i = 0; i < config.throttle.after; i += 1) {
      await request(app).get("/api/user/nobody%40example.com");
    }

    const startedAt = Date.now();
    const res = await request(app).get("/api/user/nobody%40example.com");
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(429);
    expect(elapsed).toBeGreaterThanOrEqual(config.throttle.delayMs);
  });
});
