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
 * A transaction from a sandbox build is not present in production, so a
 * production miss falls back to sandbox rather than being treated as invalid.
 * The environment that answered is carried through onto the entitlement so
 * sandbox purchases stay distinguishable from real ones.
 */
export const getSubscriptionState = async (originalTransactionId) => {
  const path = `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;
  const order =
    config.apple.environment === "Sandbox"
      ? ["Sandbox", "Production"]
      : ["Production", "Sandbox"];

  for (const environment of order) {
    const body = await callApi(path, environment);
    if (body) return { ...body, environment: body.environment || environment };
  }

  return null;
};

/** Flattens the API response into the fields the entitlement model needs. */
export const toEntitlementShape = (statusResponse) => {
  const group = statusResponse?.data?.[0];
  const last = group?.lastTransactions?.[0];

  if (!last) {
    throw new AppleVerificationError("No transaction found for this subscription");
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
