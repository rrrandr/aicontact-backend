import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../../config/env";
import { logger } from "../../util/logger";

/**
 * Apple StoreKit 2 verification.
 *
 * Two independent checks, both required:
 *
 *   1. The signed payload's certificate chain is validated back to an Apple
 *      root, and the JWS signature is verified with the leaf's public key.
 *      This proves Apple produced the payload.
 *   2. The subscription's current state is then read from the App Store
 *      Server API. This proves the payload is not simply an old one being
 *      replayed after a refund or cancellation.
 *
 * The client is never trusted for expiry, product, or status.
 */

const API_HOSTS = {
  Production: "https://api.storekit.itunes.apple.com",
  Sandbox: "https://api.storekit-sandbox.itunes.apple.com",
};

// Apple's subscription status codes.
const STATUS = {
  1: "active",
  2: "expired",
  3: "grace", // billing retry
  4: "grace", // billing grace period
  5: "revoked",
};

export class AppleVerificationError extends Error {
  constructor(message, code = "apple_verification_failed") {
    super(message);
    this.code = code;
    this.statusCode = 400;
  }
}

const decodeSegment = (segment) =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

const certFromBase64 = (der) =>
  new crypto.X509Certificate(Buffer.from(der, "base64"));

/**
 * Validates the x5c chain: leaf <- intermediate <- root, with the root pinned
 * to a configured Apple certificate.
 *
 * APPLE_ROOT_CERTS must hold Apple's root CA (base64 DER, comma-separated for
 * more than one). There is deliberately no default: a chain validated against
 * an unpinned root proves nothing, so with no root configured this refuses to
 * verify rather than silently accepting anything Apple-shaped.
 */
const validateChain = (x5c) => {
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new AppleVerificationError("Signed payload has no certificate chain");
  }

  const roots = config.apple.rootCerts;
  if (!roots.length) {
    throw new AppleVerificationError(
      "APPLE_ROOT_CERTS is not configured; refusing to verify against an unpinned root",
      "apple_root_not_configured"
    );
  }

  const chain = x5c.map(certFromBase64);
  const now = Date.now();

  for (const cert of chain) {
    if (new Date(cert.validFrom).getTime() > now) {
      throw new AppleVerificationError("Certificate in chain is not yet valid");
    }
    if (new Date(cert.validTo).getTime() < now) {
      throw new AppleVerificationError("Certificate in chain has expired");
    }
  }

  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
      throw new AppleVerificationError("Certificate chain does not validate");
    }
  }

  const presentedRoot = chain[chain.length - 1];
  const trusted = roots.map((der) => certFromBase64(der));
  const matches = trusted.some(
    (root) => root.fingerprint256 === presentedRoot.fingerprint256
  );

  if (!matches) {
    throw new AppleVerificationError(
      "Certificate chain does not terminate at a pinned Apple root"
    );
  }

  return chain[0];
};

/**
 * Verifies a JWS produced by Apple and returns its payload.
 * Used for both StoreKit 2 transactions and Server Notification bodies.
 */
export const verifySignedPayload = (signedPayload) => {
  if (typeof signedPayload !== "string" || signedPayload.split(".").length !== 3) {
    throw new AppleVerificationError("Malformed signed payload");
  }

  const [headerSegment] = signedPayload.split(".");
  const header = decodeSegment(headerSegment);

  if (header.alg !== "ES256") {
    throw new AppleVerificationError(`Unexpected signing algorithm ${header.alg}`);
  }

  const leaf = validateChain(header.x5c);

  try {
    return jwt.verify(signedPayload, leaf.publicKey, { algorithms: ["ES256"] });
  } catch (error) {
    throw new AppleVerificationError(`Signature verification failed: ${error.message}`);
  }
};

/** Bearer token for the App Store Server API, signed with the .p8 key. */
const apiToken = () =>
  jwt.sign(
    {
      iss: config.apple.issuerId,
      aud: "appstoreconnect-v1",
      bid: config.apple.bundleId,
    },
    config.apple.privateKey,
    {
      algorithm: "ES256",
      keyid: config.apple.keyId,
      expiresIn: "20m",
    }
  );

const callApi = async (path, environment) => {
  const host = API_HOSTS[environment] || API_HOSTS.Production;
  const response = await fetch(`${host}${path}`, {
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      Accept: "application/json",
    },
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const body = await response.text();
    throw new AppleVerificationError(
      `App Store Server API returned ${response.status}: ${body.slice(0, 200)}`,
      "apple_api_error"
    );
  }

  return response.json();
};

/**
 * Reads authoritative subscription state.
 *
 * A sandbox transaction is absent from production, so both hosts are tried.
 * The environment recorded is the HOST THAT ANSWERED, never the environment
 * field in the response body - a body claiming "Production" from the sandbox
 * host would otherwise launder a free purchase into a real entitlement.
 */
export const getSubscriptionState = async (originalTransactionId) => {
  const path = `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;
  const order =
    config.apple.environment === "Sandbox"
      ? ["Sandbox", "Production"]
      : ["Production", "Sandbox"];

  for (const environment of order) {
    const body = await callApi(path, environment);
    if (body) return { ...body, environment };
  }

  return null;
};

/**
 * Environment policy, applied wherever an entitlement could be created or
 * evaluated. Fails closed: anything that is not Production requires explicit
 * opt-in.
 */
export const environmentAllowed = (environment) =>
  environment === "Production" || config.apple.allowSandbox;

export const assertEnvironmentAllowed = (environment) => {
  if (!environmentAllowed(environment)) {
    throw new AppleVerificationError(
      `Refusing a ${environment} entitlement in this environment`,
      "apple_environment_rejected"
    );
  }
};

/** An allowlist, when configured, so any product under the bundle will not do. */
export const assertProductAllowed = (productId) => {
  const allowed = config.apple.productIds;
  if (allowed.length && !allowed.includes(productId)) {
    throw new AppleVerificationError(
      `Product ${productId} is not one we sell`,
      "apple_unknown_product"
    );
  }
};

/**
 * Flattens the API response into the fields the entitlement model needs.
 *
 * Apple returns every subscription in the group, so the transaction is
 * selected by original transaction id. Taking the first entry reads a
 * different subscription's state onto this purchase.
 */
export const toEntitlementShape = (statusResponse, originalTransactionId) => {
  const all = (statusResponse?.data || []).flatMap(
    (group) => group?.lastTransactions || []
  );

  const last = originalTransactionId
    ? all.find((entry) => entry.originalTransactionId === originalTransactionId)
    : all[0];

  if (!last) {
    throw new AppleVerificationError(
      "No transaction matching this subscription was returned",
      "apple_transaction_not_found"
    );
  }

  const transaction = last.signedTransactionInfo
    ? verifySignedPayload(last.signedTransactionInfo)
    : {};
  const renewal = last.signedRenewalInfo
    ? verifySignedPayload(last.signedRenewalInfo)
    : {};

  const status = STATUS[last.status] || "expired";

  return {
    originalTransactionId: last.originalTransactionId,
    transactionId: transaction.transactionId,
    productId: transaction.productId,
    status: transaction.revocationDate ? "refunded" : status,
    startsAt: transaction.purchaseDate ? new Date(transaction.purchaseDate) : null,
    expiresAt: transaction.expiresDate ? new Date(transaction.expiresDate) : null,
    autoRenew: renewal.autoRenewStatus === 1,
    environment: statusResponse.environment || "Production",
    appleStatus: last.status,
    revocationDate: transaction.revocationDate
      ? new Date(transaction.revocationDate)
      : null,
    revocationReason: transaction.revocationReason,
  };
};

/** Guards against a payload minted for a different application. */
export const assertBundleId = (payload) => {
  const bundleId = payload.bundleId || payload.bid || payload?.data?.bundleId;
  if (bundleId && bundleId !== config.apple.bundleId) {
    logger.warn("apple payload for unexpected bundle", { bundleId });
    throw new AppleVerificationError("Payload is for a different application");
  }
};
