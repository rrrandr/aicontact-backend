import { paypalFetch } from "../../src/v2/services/paypalService";

/**
 * A transient PayPal failure surfaced as a user-visible 502 in the sandbox run:
 * two identical calls 434ms apart returned 502 then 200. These fix the
 * behaviour and pin the boundary between retryable and permanent.
 */
const responder = (statuses) => {
  let i = 0;
  const calls = [];
  const fn = async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    calls.push(status);
    i += 1;
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
};

describe("paypalFetch retry policy", () => {
  it("retries once on 401 and succeeds", async () => {
    const build = responder([401, 200]);
    const res = await paypalFetch("test", build);
    expect(res.status).toBe(200);
    expect(build.calls).toEqual([401, 200]);
  });

  it("retries a 429 with backoff", async () => {
    const build = responder([429, 200]);
    const res = await paypalFetch("test", build);
    expect(res.status).toBe(200);
    expect(build.calls.length).toBe(2);
  });

  it("retries a 5xx", async () => {
    const build = responder([503, 200]);
    expect((await paypalFetch("test", build)).status).toBe(200);
  });

  it("does NOT retry an ordinary 4xx validation failure", async () => {
    const build = responder([400, 200]);
    const res = await paypalFetch("test", build);
    expect(res.status).toBe(400);
    expect(build.calls).toEqual([400]);   // exactly one attempt
  });

  it("does not retry a 422", async () => {
    const build = responder([422, 200]);
    expect((await paypalFetch("test", build)).status).toBe(422);
    expect(build.calls.length).toBe(1);
  });

  it("passes 404 straight through without retrying", async () => {
    const build = responder([404, 200]);
    expect((await paypalFetch("test", build)).status).toBe(404);
    expect(build.calls.length).toBe(1);
  });

  it("is bounded: a permanently failing upstream stops after 3 attempts", async () => {
    const build = responder([500]);
    const res = await paypalFetch("test", build);
    expect(res.status).toBe(500);
    expect(build.calls.length).toBe(3);
  });

  it("returns success immediately without retrying", async () => {
    const build = responder([200]);
    expect((await paypalFetch("test", build)).status).toBe(200);
    expect(build.calls.length).toBe(1);
  });
});
