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

/**
 * The host this service will actually talk to. Exposed so a caller about to
 * do something destructive can verify it, rather than inferring it from
 * configuration that might be read differently here.
 */
export const currentHost = () => host();

let cachedToken = null;

export const resetTokenCache = () => {
  cachedToken = null;
};

/**
 * One bounded retry policy for every PayPal call.
 *
 * A 401 usually means the cached token was invalidated server-side before it
 * expired; the fix is a fresh token, not a failure shown to the user. 429 and
 * 5xx are transient by definition. Ordinary 4xx are the caller's fault and
 * must not be retried - repeating a rejected request only delays the error.
 *
 * Only the status, the category and the attempt number are logged. Response
 * bodies are not: they carry subscriber details.
 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 750];

const categorise = (status) => {
  if (status === 401) return "auth";
  if (status === 429) return "throttled";
  if (status >= 500) return "upstream";
  return "permanent";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const paypalFetch = async (label, build) => {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await build();
    if (response.ok || response.status === 404) return response;

    lastStatus = response.status;
    const category = categorise(response.status);

    if (category === "permanent" || attempt === MAX_ATTEMPTS) {
      logger.warn("paypal call failed", {
        call: label,
        status: response.status,
        category,
        attempt,
      });
      return response;
    }

    logger.warn("paypal call retrying", {
      call: label,
      status: response.status,
      category,
      attempt,
    });

    // A rejected token is worth nothing; force a fresh one before retrying.
    if (category === "auth") resetTokenCache();
    await sleep(BACKOFF_MS[attempt - 1] ?? 750);
  }

  return { ok: false, status: lastStatus, json: async () => ({}) };
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
  const response = await paypalFetch("getSubscription", async () =>
    fetch(`${host()}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        Accept: "application/json",
      },
    })
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

/**
 * Creates a subscription with the account binding set by us.
 *
 * custom_id comes from the session, never from the request body, and PayPal
 * echoes it back on lookup - which is what makes ownership verifiable rather
 * than merely asserted.
 */
export const createSubscription = async ({ planId, customId }) => {
  const response = await fetch(`${host()}/v1/billing/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: customId,
      application_context: {
        user_action: "SUBSCRIBE_NOW",
        ...(config.paypal.returnUrl ? { return_url: config.paypal.returnUrl } : {}),
        ...(config.paypal.cancelUrl ? { cancel_url: config.paypal.cancelUrl } : {}),
      },
    }),
  });

  if (!response.ok) {
    throw new PaypalError(
      `PayPal subscription creation failed (${response.status})`,
      "paypal_create_failed",
      502
    );
  }

  const body = await response.json();
  const approve = (body.links || []).find((link) => link.rel === "approve");

  return { id: body.id, status: body.status, approveUrl: approve ? approve.href : null };
};

// SUSPENDED is deliberately absent. Suspension pauses collection but leaves
// the billing agreement in place and it can be reactivated, so it does not
// settle whether someone will be charged again.
const INACTIVE_STATUSES = new Set(["CANCELLED", "EXPIRED"]);

/**
 * Asks PayPal to cancel, then confirms the result from PayPal's own record.
 *
 * The response status alone is not proof. 422 in particular covers several
 * conditions - only one of which is "already inactive" - so treating every
 * 422 as success silently strands a subscription that is still billing.
 * What settles it is reading the subscription back.
 */
export const cancelSubscription = async (subscriptionId, reason) => {
  let requestError = null;

  try {
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

    if (!response.ok) {
      requestError = `cancel returned ${response.status}`;
      logger.warn("paypal cancellation call did not succeed", {
        subscription_id: subscriptionId,
        status: response.status,
      });
    }
  } catch (error) {
    requestError = error.message;
  }

  // Confirm against PayPal rather than trusting the call's status code.
  try {
    const subscription = await getSubscription(subscriptionId);

    if (!subscription) {
      return { cancelled: true, confirmed: true, detail: "subscription no longer exists" };
    }

    const status = String(subscription.status || "").toUpperCase();
    if (INACTIVE_STATUSES.has(status)) {
      return { cancelled: true, confirmed: true, detail: status };
    }

    return {
      cancelled: false,
      confirmed: true,
      detail: `still ${status}${requestError ? ` (${requestError})` : ""}`,
    };
  } catch (error) {
    return {
      cancelled: false,
      confirmed: false,
      detail: requestError || error.message,
    };
  }
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

/**
 * Whether this subscription is bound to this account.
 *
 * A subscription id is not a secret - it appears in receipts, customer emails
 * and PayPal's own interface - so presenting one proves nothing. Only the
 * custom_id we set at creation does.
 */
export const ownershipMatches = (subscription, subjectId) =>
  Boolean(subjectId) && subscription?.custom_id === subjectId;

export const hasNoBinding = (subscription) =>
  !subscription?.custom_id || String(subscription.custom_id).trim() === "";

export const subscriberEmail = (subscription) =>
  subscription?.subscriber?.email_address || null;

/** A subscription for a plan we do not sell must never grant entitlement. */
export const assertKnownPlan = (planId) => {
  if (!config.paypal.planIds.includes(planId)) {
    throw new PaypalError(
      "Subscription is not for a recognised plan",
      "paypal_unknown_plan"
    );
  }
};

/**
 * Which plan a subscribe request should use.
 *
 * The client does not choose. A released build that carried a plan id would
 * pin itself to that plan forever, and a client-supplied id is an input we
 * would have to validate anyway. So when exactly one plan is configured the
 * server selects it; only a genuinely multi-plan deployment has to be told
 * which one, and even then the value must already be on the allowlist.
 */
export const resolvePlanId = (requested) => {
  const configured = config.paypal.planIds;

  if (configured.length === 0) {
    throw new PaypalError(
      "No PayPal plan is configured; PAYPAL_PLAN_IDS is empty",
      "paypal_no_plan_configured",
      500
    );
  }

  if (requested === undefined || requested === null || requested === "") {
    if (configured.length === 1) return configured[0];
    throw new PaypalError(
      "Several plans are configured; plan_id is required",
      "paypal_plan_id_required",
      400
    );
  }

  if (typeof requested !== "string") {
    throw new PaypalError("plan_id must be a string", "paypal_unknown_plan", 400);
  }

  assertKnownPlan(requested);
  return requested;
};
