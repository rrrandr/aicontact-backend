import { redact, tail } from "../../src/util/redact";

describe("redaction", () => {
  const original = process.env.PAYPAL_CLIENT_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = original;
  });

  it("removes a known secret wherever it appears", () => {
    process.env.PAYPAL_CLIENT_SECRET = "EXAMPLE-SECRET-VALUE-abcdefghijklmnop";
    const line = `curl -u id:${process.env.PAYPAL_CLIENT_SECRET} https://api-m.sandbox.paypal.com`;

    const out = redact(line);
    expect(out).not.toContain("EXAMPLE-SECRET-VALUE");
    expect(out).toContain("<PAYPAL_CLIENT_SECRET>");
  });

  it("removes authorization headers of both schemes", () => {
    expect(redact('Authorization: Bearer A1b2C3d4E5f6G7h8I9j0KlMnOp')).not.toContain("A1b2C3d4");
    expect(redact('"Authorization":"Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng=="')).not.toContain("dXNlcjpw");
  });

  it("removes access tokens from response bodies", () => {
    const out = redact('{"access_token":"A21AAJ_abcdefghijklmnopqrstuvwxyz","expires_in":32400}');
    expect(out).not.toContain("A21AAJ_abcdefghij");
    expect(out).toContain("expires_in");
  });

  it("removes credentialed database URIs and private keys", () => {
    expect(redact("mongodb://user:pw@host:27017/db")).toBe("mongodb://<redacted>");
    expect(
      redact("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")
    ).toBe("<private key redacted>");
  });

  it("masks customer addresses but keeps the domain readable", () => {
    expect(redact("buyer: someone@personal.example.com")).toBe(
      "buyer: s***@personal.example.com"
    );
  });

  it("shortens PayPal identifiers rather than printing them whole", () => {
    expect(redact("subscription I-BW452GLLEP1G")).toBe("subscription I-***EP1G");
    expect(redact("plan P-5ML4271244454362WXNWU5NQ")).toContain("P-***");
  });

  it("leaves ordinary text alone", () => {
    const line = "created subscription for plan, status ACTIVE, 2 events";
    expect(redact(line)).toBe(line);
  });

  it("keeps an identifier recognisable", () => {
    expect(tail("I-BW452GLLEP1G", 4)).toBe("***EP1G");
    expect(tail("ab", 4)).toBe("***");
  });
});
