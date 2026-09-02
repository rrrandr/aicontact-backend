// The original schema regex rejected valid addresses: anything with a
// four-or-more letter TLD (.info, .museum), and plus-addressing was accepted
// only incidentally. This is deliberately permissive about the local part and
// strict only about the shape, which is as much as a regex can honestly do.
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

export const isValidEmail = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  !value.includes("..") &&
  EMAIL_PATTERN.test(value);

// Normalization is case-folding and trimming only. It deliberately does NOT
// strip plus-tags or dots: those are provider-specific conventions, and
// applying them would merge accounts that already exist separately.
export const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
