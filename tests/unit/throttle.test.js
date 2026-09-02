import { createThrottle } from "../../src/middlewears/throttle";

const OPTS = { after: 3, delayMs: 1, maxDelayMs: 2, windowMs: 60000, hardMax: 10 };

const makeRes = () => ({
  statusCode: null,
  payload: null,
  headers: {},
  writableEnded: false,
  set(k, v) { this.headers[k] = v; return this; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.payload = body; this.writableEnded = true; return this; },
});

const call = async (middleware, ip) => {
  const res = makeRes();
  let passed = false;
  await middleware({ ip, path: "/api/user/x" }, res, () => { passed = true; });
  return { res, passed };
};

describe("throttle", () => {
  it("never rejects below the circuit breaker", async () => {
    // The property that matters. Released clients retry failed calls forever
    // with no backoff, so any 4xx on these endpoints becomes a hot loop
    // (InAppPurchaseScreenHandler.cs:159-162, 315-318).
    const t = createThrottle(OPTS);
    for (let i = 0; i < OPTS.hardMax; i += 1) {
      const { res, passed } = await call(t, "10.0.0.1");
      expect(res.statusCode).toBeNull();
      expect(passed).toBe(true);
    }
  });

  it("applies backpressure by delaying rather than failing", async () => {
    const slow = createThrottle({ ...OPTS, delayMs: 40, maxDelayMs: 200 });
    for (let i = 0; i < OPTS.after; i += 1) await call(slow, "10.0.0.9");

    const startedAt = Date.now();
    const { res, passed } = await call(slow, "10.0.0.9");
    const elapsed = Date.now() - startedAt;

    expect(passed).toBe(true);
    expect(res.statusCode).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it("rejects only once the circuit breaker trips", async () => {
    const t = createThrottle(OPTS);
    for (let i = 0; i < OPTS.hardMax; i += 1) await call(t, "10.0.0.2");
    const { res, passed } = await call(t, "10.0.0.2");
    expect(res.statusCode).toBe(429);
    expect(passed).toBe(false);
    expect(res.headers["Retry-After"]).toBeDefined();
  });

  it("counts each client separately", async () => {
    const t = createThrottle(OPTS);
    for (let i = 0; i < OPTS.hardMax + 5; i += 1) await call(t, "10.0.0.3");
    const { res } = await call(t, "10.0.0.4");
    expect(res.statusCode).toBeNull();
  });

  it("starts a fresh window after the previous one expires", async () => {
    const t = createThrottle({ ...OPTS, windowMs: 30 });
    for (let i = 0; i < OPTS.hardMax + 2; i += 1) await call(t, "10.0.0.5");
    await new Promise((r) => setTimeout(r, 45));
    const { res } = await call(t, "10.0.0.5");
    expect(res.statusCode).toBeNull();
  });
});
