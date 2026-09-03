/**
 * Validation for the URLs PayPal sends a buyer back to.
 *
 * PayPal appends approval parameters - subscription_id, token, ba_token - to
 * the return URL, so whoever operates that host receives them. A placeholder
 * like example.com is a real host operated by someone else, which makes it a
 * quiet exfiltration of sandbox identifiers. Loopback keeps them on the
 * machine; anything else has to be a host we actually own and have named.
 */

export class UnsafeRedirect extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Reserved documentation domains, and the hosts people reach for when they
// want "somewhere that isn't real". All of them are real.
const NEVER = [
  "example.com",
  "example.org",
  "example.net",
  "example.edu",
  "test.com",
  "localhost.com",
];

const allowedHostsFrom = (env = process.env) =>
  String(env.PAYPAL_ALLOWED_REDIRECT_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

export const assertSafeRedirect = (value, { label = "redirect URL", env = process.env } = {}) => {
  if (!value || typeof value !== "string") {
    throw new UnsafeRedirect(`${label} is not set.`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeRedirect(`${label} is not a valid URL: "${value}"`);
  }

  const host = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK.has(host);

  if (url.protocol !== "https:" && !isLoopback) {
    throw new UnsafeRedirect(`${label} must use https, got "${url.protocol}//" for ${host}`);
  }

  if (NEVER.some((bad) => host === bad || host.endsWith(`.${bad}`))) {
    throw new UnsafeRedirect(
      `${label} points at ${host}, which is a real host operated by someone else. ` +
        `PayPal appends approval parameters to this URL. Use https://localhost/... ` +
        `or a domain you own listed in PAYPAL_ALLOWED_REDIRECT_HOSTS.`
    );
  }

  if (isLoopback) return true;

  const allowed = allowedHostsFrom(env);
  if (!allowed.includes(host)) {
    throw new UnsafeRedirect(
      `${label} points at ${host}, which is neither loopback nor listed in ` +
        `PAYPAL_ALLOWED_REDIRECT_HOSTS. Add it there only if you own it.`
    );
  }

  return true;
};

export const assertSafeRedirects = (env = process.env) => {
  assertSafeRedirect(env.PAYPAL_RETURN_URL, { label: "PAYPAL_RETURN_URL", env });
  assertSafeRedirect(env.PAYPAL_CANCEL_URL, { label: "PAYPAL_CANCEL_URL", env });
  return true;
};
