const jwt = require("jsonwebtoken");
const { appleCerts } = require("./appleCerts");

/** Signs a payload the way Apple would, using the trusted test chain. */
const signApple = (payload) => {
  const { trusted } = appleCerts();
  return jwt.sign(payload, trusted.leafKey, {
    algorithm: "ES256",
    header: { alg: "ES256", x5c: trusted.x5c },
  });
};

const DAY = 24 * 60 * 60 * 1000;

const appleTransaction = (overrides = {}) => ({
  originalTransactionId: "2000000000000001",
  transactionId: "2000000000000002",
  productId: "com.facestream.aicontact.monthly",
  bundleId: "com.FaceStreamCorporation.AICONTACT",
  purchaseDate: Date.now() - DAY,
  expiresDate: Date.now() + 30 * DAY,
  ...overrides,
});

/** The App Store Server API subscription-status response shape. */
const appleStatusResponse = (
  transaction,
  { status = 1, autoRenew = 1, environment = "Production" } = {}
) => ({
  environment,
  bundleId: "com.FaceStreamCorporation.AICONTACT",
  data: [
    {
      subscriptionGroupIdentifier: "group-1",
      lastTransactions: [
        {
          originalTransactionId: transaction.originalTransactionId,
          status,
          signedTransactionInfo: signApple(transaction),
          signedRenewalInfo: signApple({ autoRenewStatus: autoRenew }),
        },
      ],
    },
  ],
});

/**
 * A response carrying several transactions across several groups, so the
 * server has to select by originalTransactionId rather than taking the first.
 */
const appleMultiStatusResponse = (entries, { environment = "Production" } = {}) => ({
  environment,
  bundleId: "com.FaceStreamCorporation.AICONTACT",
  data: entries.map((group, index) => ({
    subscriptionGroupIdentifier: `group-${index + 1}`,
    lastTransactions: group.map(({ transaction, status = 1, autoRenew = 1 }) => ({
      originalTransactionId: transaction.originalTransactionId,
      status,
      signedTransactionInfo: signApple(transaction),
      signedRenewalInfo: signApple({ autoRenewStatus: autoRenew }),
    })),
  })),
});

const paypalSubscription = (overrides = {}) => ({
  id: "I-TESTSUB00001",
  plan_id: "P-TEST-PLAN-1",
  status: "ACTIVE",
  start_time: new Date(Date.now() - DAY).toISOString(),
  billing_info: {
    next_billing_time: new Date(Date.now() + 30 * DAY).toISOString(),
  },
  ...overrides,
});

/**
 * Routes fetch by URL so a test can describe what each provider returns
 * without caring about call order.
 */
const installFetchStub = (routes) => {
  const calls = [];

  global.fetch = jest.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });

    for (const [pattern, handler] of Object.entries(routes)) {
      if (String(url).includes(pattern)) {
        const result = typeof handler === "function" ? await handler(url, options) : handler;
        return {
          ok: result.status === undefined || (result.status >= 200 && result.status < 300),
          status: result.status ?? 200,
          json: async () => result.body,
          text: async () => JSON.stringify(result.body ?? ""),
        };
      }
    }

    throw new Error(`Unstubbed fetch to ${url}`);
  });

  return calls;
};

const paypalAuthRoute = {
  "/v1/oauth2/token": { body: { access_token: "test-token", expires_in: 3600 } },
};

module.exports = {
  signApple,
  appleTransaction,
  appleStatusResponse,
  appleMultiStatusResponse,
  paypalSubscription,
  installFetchStub,
  paypalAuthRoute,
  DAY,
};
