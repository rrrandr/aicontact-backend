import jwt from "jsonwebtoken";
import { appleCerts, opensslAvailable } from "../helpers/appleCerts";

const describeIfSsl = opensslAvailable() ? describe : describe.skip;

describeIfSsl("Apple signed-payload verification", () => {
  let certs;
  let verifySignedPayload;
  let AppleVerificationError;

  const sign = (payload, chain, key, options = {}) =>
    jwt.sign(payload, key, {
      algorithm: "ES256",
      header: { alg: "ES256", x5c: chain },
      ...options,
    });

  beforeAll(() => {
    certs = appleCerts();
    process.env.APPLE_ROOT_CERTS = certs.trusted.rootDer;
    jest.resetModules();
    const mod = require("../../src/v2/services/appleService");
    verifySignedPayload = mod.verifySignedPayload;
    AppleVerificationError = mod.AppleVerificationError;
  });

  it("accepts a payload signed by a chain rooted at the pinned certificate", () => {
    const token = sign(
      { originalTransactionId: "2000000000000001", productId: "monthly" },
      certs.trusted.x5c,
      certs.trusted.leafKey
    );

    const payload = verifySignedPayload(token);
    expect(payload.originalTransactionId).toBe("2000000000000001");
    expect(payload.productId).toBe("monthly");
  });

  it("rejects a valid chain that terminates at a different root", () => {
    // The attack this defends against: a well-formed chain from a CA the
    // attacker controls. Without root pinning it would verify perfectly.
    const token = sign(
      { originalTransactionId: "forged" },
      certs.untrusted.x5c,
      certs.untrusted.leafKey
    );

    expect(() => verifySignedPayload(token)).toThrow(/pinned Apple root/);
  });

  it("rejects a payload whose signature does not match its certificate", () => {
    const token = sign(
      { originalTransactionId: "mismatched" },
      certs.trusted.x5c,
      certs.untrusted.leafKey
    );

    expect(() => verifySignedPayload(token)).toThrow(/Signature verification failed/);
  });

  it("rejects a tampered payload", () => {
    const token = sign(
      { originalTransactionId: "2000000000000002" },
      certs.trusted.x5c,
      certs.trusted.leafKey
    );

    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ originalTransactionId: "9999999999999999" })
    ).toString("base64url");

    expect(() => verifySignedPayload(`${header}.${forged}.${signature}`)).toThrow();
  });

  it("rejects a chain presented with a mismatched leaf", () => {
    const token = sign(
      { originalTransactionId: "swapped" },
      [certs.untrusted.x5c[0], certs.trusted.x5c[1], certs.trusted.x5c[2]],
      certs.untrusted.leafKey
    );

    expect(() => verifySignedPayload(token)).toThrow(/chain does not validate/);
  });

  it("rejects an algorithm other than ES256", () => {
    const token = jwt.sign({ originalTransactionId: "hs256" }, "a-shared-secret", {
      algorithm: "HS256",
      header: { alg: "HS256", x5c: certs.trusted.x5c },
    });

    expect(() => verifySignedPayload(token)).toThrow(/Unexpected signing algorithm/);
  });

  it("rejects a payload carrying no chain at all", () => {
    const token = jwt.sign({ originalTransactionId: "nochain" }, certs.trusted.leafKey, {
      algorithm: "ES256",
    });

    expect(() => verifySignedPayload(token)).toThrow(/no certificate chain/);
  });

  it("rejects a malformed payload", () => {
    expect(() => verifySignedPayload("not-a-jws")).toThrow(/Malformed/);
    expect(() => verifySignedPayload(null)).toThrow(/Malformed/);
  });

  it("refuses to verify anything when no root is pinned", () => {
    process.env.APPLE_ROOT_CERTS = "";
    jest.resetModules();
    const mod = require("../../src/v2/services/appleService");

    const token = sign(
      { originalTransactionId: "unpinned" },
      certs.trusted.x5c,
      certs.trusted.leafKey
    );

    // Failing closed matters more here than convenience: an unpinned root
    // makes chain validation meaningless.
    expect(() => mod.verifySignedPayload(token)).toThrow(/not configured/);

    process.env.APPLE_ROOT_CERTS = certs.trusted.rootDer;
  });
});
