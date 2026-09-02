import { config } from "../../config/env";
import { logger } from "../../util/logger";

/**
 * PayPal subscription verification, performed entirely server-side.
 *
 * The desktop client previously held the live REST client ID and secret in a
 * serialized scene field and called PayPal directly. Those credentials must
 * not exist in any client build; they are read here from the environment.
 */

const HOSTS = {
  live: "https://api-m.paypal.com",
  sandbox: "https://api-m.sandbox.paypal.com",
};

export class PaypalError extends Error {
  constructor(message, code = "paypal_error", statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const host = () => HOSTS[config.paypal.env] || HOSTS.live;

let cachedToken = null;

export const resetTokenCache = () => {
  cachedToken = null;
};

const accessToken = async () => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.value;
  }

  const credentials = Buffer.from(
    `${config.paypal.clientId}:${config.paypal.clientSecret}`
  ).toString("base64");

  const response = await fetch(`${host()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new PaypalError(
      `Could not obtain PayPal access token (${response.status})`,
      "paypal_auth_failed",
      502
    );
  }

  const body = await response.json();
  cachedToken = {
    value: body.access_token,
    // Honour the stated lifetime rather than assuming one.
    expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
  };

  return cachedToken.value;
};

export const getSubscription = async (subscriptionId) => {
  const response = await fetch(
    `${host()}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        Accept: "application/json",
      },
    }
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new PaypalError(
      `PayPal subscription lookup failed (${response.status})`,
      "paypal_lookup_failed",
      502
    );
  }

  return response.json();
};

export const cancelSubscription = async (subscriptionId, reason) => {
  const response = await fetch(
    `${host()}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: reason || "Account deleted" }),
    }
  );

  // 204 on success; 422 when it is already inactive, which is not an error
  // from our point of view.
  if (!response.ok && response.status !== 422) {
    logger.warn("paypal cancellation failed", {
      subscription_id: subscriptionId,
      status: response.status,
    });
    return false;
  }

  return true;
};

/**
 * Verifies a webhook against PayPal's own verification endpoint.
 *
 * Signature checking is delegated to PayPal rather than reimplemented, and a
 * non-SUCCESS answer is treated as a failure - an unverified webhook must
 * never be allowed to change entitlement state.
 */
export const verifyWebhookSignature = async (headers, rawBody) => {
  const required = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
  ];

  for (const header of required) {
    if (!headers[header]) {
      logger.warn("paypal webhook missing header", { header });
      return false;
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const response = await fetch(
    `${host()}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: config.paypal.webhookId,
        webhook_event: event,
      }),
    }
  );

  if (!response.ok) {
    logger.warn("paypal signature verification call failed", {
      status: response.status,
    });
    return false;
  }

  const body = await response.json();
  return body.verification_status === "SUCCESS";
};

/** Maps PayPal's subscription status onto our entitlement vocabulary. */
export const toEntitlementShape = (subscription) => {
  const status = String(subscription.status || "").toUpperCase();

  const mapped =
    status === "ACTIVE"
      ? "active"
      : status === "SUSPENDED"
      ? "grace"
      : status === "CANCELLED" || status === "EXPIRED"
      ? "expired"
      : "expired";

  const nextBilling = subscription?.billing_info?.next_billing_time
    ? new Date(subscription.billing_info.next_billing_time)
    : null;

  return {
    subscriptionId: subscription.id,
    planId: subscription.plan_id,
    status: mapped,
    rawStatus: status,
    startsAt: subscription.start_time ? new Date(subscription.start_time) : null,
    // PayPal has no "expires" for an active subscription; the next billing
    // date is the point by which we must have seen a renewal.
    expiresAt: nextBilling,
    autoRenew: status === "ACTIVE",
  };
};

/** A subscription for a plan we do not sell must never grant entitlement. */
export const assertKnownPlan = (planId) => {
  if (!config.paypal.planIds.includes(planId)) {
    throw new PaypalError(
      "Subscription is not for a recognised plan",
      "paypal_unknown_plan"
    );
  }
};
