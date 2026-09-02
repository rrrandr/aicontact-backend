import crypto from "crypto";

export const randomToken = (bytes = 32) =>
  crypto.randomBytes(bytes).toString("base64url");

export const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

// Source addresses are recorded as a keyed hash so audit rows stay useful for
// correlation without storing the address itself.
export const hashIp = (ip) =>
  ip ? crypto.createHash("sha256").update(`ip:${ip}`).digest("hex").slice(0, 32) : undefined;

export const newSubjectId = () => `sub_${crypto.randomBytes(16).toString("hex")}`;

// Constant-time comparison for values that gate access.
export const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

export const stableHash = (value) =>
  sha256(JSON.stringify(value ?? null));
