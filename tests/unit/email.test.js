import { isValidEmail, normalizeEmail } from "../../src/util/email";

describe("email validation", () => {
  it("accepts addresses the original regex wrongly rejected", () => {
    // The original pattern was /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
    // which caps the TLD at three characters and rejects plus-addressing.
    expect(isValidEmail("roman@facestream.info")).toBe(true);
    expect(isValidEmail("roman@example.museum")).toBe(true);
    expect(isValidEmail("roman+aicontact@example.com")).toBe(true);
    expect(isValidEmail("first.last@sub.example.co.uk")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidEmail("no-at-sign")).toBe(false);
    expect(isValidEmail("two@@example.com")).toBe(false);
    expect(isValidEmail("trailing@example")).toBe(false);
    expect(isValidEmail("double..dot@example.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("email normalization", () => {
  it("folds case and trims", () => {
    expect(normalizeEmail("  Roman@Example.COM ")).toBe("roman@example.com");
  });

  it("leaves provider-specific conventions alone", () => {
    // Stripping plus-tags or dots would merge accounts that already exist
    // separately in production.
    expect(normalizeEmail("a+tag@example.com")).toBe("a+tag@example.com");
    expect(normalizeEmail("a.b@example.com")).toBe("a.b@example.com");
  });

  it("survives non-string input", () => {
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(null)).toBe("");
  });
});
