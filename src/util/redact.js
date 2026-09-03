/**
 * Redaction for anything a sandbox run might print.
 *
 * Credentials must not reach a terminal, a log file, or a transcript, so this
 * scrubs both the values we know (read from the environment at call time) and
 * the shapes we do not (bearer tokens, basic auth, addresses, PayPal ids).
 *
 * Value-based redaction comes first and is the reliable half; the patterns
 * are a backstop for values we were never handed.
 */

const SECRET_ENV_KEYS = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "JWT_ACCESS_SECRET",
  "APPLE_PRIVATE_KEY",
  "MAIL_PROVIDER_KEY",
  "CONFIG_SIGNING_KEY",
  "URI",
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keeps an identifier recognisable without disclosing it in full. */
export const tail = (value, keep = 4) => {
  const text = String(value ?? "");
  if (text.length <= keep) return "***";
  return `***${text.slice(-keep)}`;
};

export const redact = (input) => {
  let text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (!text) return text;

  // Known values first. Short values are skipped: redacting a two-character
  // string would mangle unrelated output.
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 8) {
      text = text.replace(new RegExp(escapeRegExp(value), "g"), `<${key}>`);
    }
  }

  return (
    text
      .replace(/(Authorization"?\s*[:=]\s*"?)(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi, "$1$2 <redacted>")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{16,}/g, "$1 <redacted>")
      .replace(/("?access_token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]{16,}/g, "$1<redacted>")
      .replace(/mongodb(\+srv)?:\/\/[^\s"']*/g, "mongodb://<redacted>")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private key redacted>")
      // Customer information.
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => {
        const [local, domain] = match.split("@");
        return `${local.slice(0, 1)}***@${domain}`;
      })
      // PayPal subscription and plan identifiers: recognisable, not reusable.
      .replace(/\bI-[A-Z0-9]{6,}\b/g, (match) => `I-${tail(match)}`)
      .replace(/\bP-[A-Z0-9]{6,}\b/g, (match) => `P-${tail(match)}`)
  );
};

/** Console writer that redacts everything on the way out. */
export const safeLog = (...parts) => {
  console.log(parts.map((part) => redact(part)).join(" "));
};

export const safeError = (...parts) => {
  console.error(parts.map((part) => redact(part)).join(" "));
};
