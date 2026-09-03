import {
  assertSafeRedirect,
  assertSafeRedirects,
  UnsafeRedirect,
} from "../../scripts/lib/redirectUrls";

describe("PayPal redirect URL safety", () => {
  const env = {};

  it("accepts loopback, which keeps approval parameters on this machine", () => {
    expect(assertSafeRedirect("https://localhost/paypal/return", { env })).toBe(true);
    expect(assertSafeRedirect("http://localhost:5000/paypal/return", { env })).toBe(true);
    expect(assertSafeRedirect("https://127.0.0.1/paypal/cancel", { env })).toBe(true);
  });

  it("refuses example.com and its relatives", () => {
    // PayPal appends subscription_id and token to this URL, so a real host
    // operated by someone else receives them.
    for (const url of [
      "https://example.com/paypal/return",
      "https://example.org/x",
      "https://www.example.com/paypal/return",
      "https://test.com/return",
    ]) {
      expect(() => assertSafeRedirect(url, { env })).toThrow(UnsafeRedirect);
    }
    expect(() => assertSafeRedirect("https://example.com/r", { env })).toThrow(
      /operated by someone else/
    );
  });

  it("refuses any host that is neither loopback nor explicitly allowed", () => {
    expect(() => assertSafeRedirect("https://some-random-host.io/r", { env })).toThrow(
      /neither loopback nor listed/
    );
  });

  it("accepts a host we have declared we own", () => {
    const owned = { PAYPAL_ALLOWED_REDIRECT_HOSTS: "facestream.ai, app.facestream.ai" };
    expect(assertSafeRedirect("https://app.facestream.ai/paypal/return", { env: owned })).toBe(true);
    expect(() => assertSafeRedirect("https://other.example.io/r", { env: owned })).toThrow();
  });

  it("requires https for anything that is not loopback", () => {
    const owned = { PAYPAL_ALLOWED_REDIRECT_HOSTS: "facestream.ai" };
    expect(() => assertSafeRedirect("http://facestream.ai/r", { env: owned })).toThrow(/https/);
  });

  it("refuses missing or malformed values", () => {
    expect(() => assertSafeRedirect(undefined, { env })).toThrow(/not set/);
    expect(() => assertSafeRedirect("", { env })).toThrow(/not set/);
    expect(() => assertSafeRedirect("not-a-url", { env })).toThrow(/not a valid URL/);
  });

  it("checks both redirect variables together", () => {
    expect(
      assertSafeRedirects({
        PAYPAL_RETURN_URL: "https://localhost/paypal/return",
        PAYPAL_CANCEL_URL: "https://localhost/paypal/cancel",
      })
    ).toBe(true);

    expect(() =>
      assertSafeRedirects({
        PAYPAL_RETURN_URL: "https://localhost/paypal/return",
        PAYPAL_CANCEL_URL: "https://example.com/paypal/cancel",
      })
    ).toThrow(/PAYPAL_CANCEL_URL/);
  });
});
