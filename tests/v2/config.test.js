import request from "supertest";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { createApp } from "../../src/app";

const app = createApp();

describe("GET /config", () => {
  const originalKey = process.env.CONFIG_SIGNING_KEY;

  afterEach(() => {
    process.env.CONFIG_SIGNING_KEY = originalKey || "";
  });

  it("serves the client's base URL and version floor", async () => {
    process.env.PUBLIC_API_BASE_URL = "https://api.facestream.ai";
    process.env.MIN_CLIENT_VERSION = "2.1.0";

    const res = await request(app).get("/config");

    expect(res.status).toBe(200);
    expect(res.body.config.api_base_url).toBe("https://api.facestream.ai");
    expect(res.body.config.min_client_version).toBe("2.1.0");
    expect(res.headers["cache-control"]).toContain("max-age");
  });

  it("needs no authentication", async () => {
    const res = await request(app).get("/config");
    expect(res.status).toBe(200);
  });

  it("produces a signature the client's public key can verify", async () => {
    // Without this, control of the DNS record would be enough to point every
    // installed application at an API of someone else's choosing.
    const privateKey = execFileSync("openssl", ["genpkey", "-algorithm", "ed25519"]).toString();
    process.env.CONFIG_SIGNING_KEY = privateKey;

    const res = await request(app).get("/config");
    expect(res.body.signature).toEqual(expect.any(String));

    const publicKey = crypto.createPublicKey(privateKey);
    const verified = crypto.verify(
      null,
      Buffer.from(JSON.stringify(res.body.config)),
      publicKey,
      Buffer.from(res.body.signature, "base64")
    );

    expect(verified).toBe(true);
  });

  it("does not validate a signature against the wrong key", async () => {
    const privateKey = execFileSync("openssl", ["genpkey", "-algorithm", "ed25519"]).toString();
    const otherKey = execFileSync("openssl", ["genpkey", "-algorithm", "ed25519"]).toString();
    process.env.CONFIG_SIGNING_KEY = privateKey;

    const res = await request(app).get("/config");

    const verified = crypto.verify(
      null,
      Buffer.from(JSON.stringify(res.body.config)),
      crypto.createPublicKey(otherKey),
      Buffer.from(res.body.signature, "base64")
    );

    expect(verified).toBe(false);
  });

  it("reports an unsigned payload rather than pretending it is signed", async () => {
    process.env.CONFIG_SIGNING_KEY = "";
    const res = await request(app).get("/config");
    expect(res.body.signature).toBeNull();
  });

  it("never exposes the signing key or any provider secret", async () => {
    const res = await request(app).get("/config");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain(process.env.PAYPAL_CLIENT_SECRET);
    expect(serialized).not.toContain(process.env.JWT_ACCESS_SECRET);
  });
});
