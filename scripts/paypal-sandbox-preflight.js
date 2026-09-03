/**
 * Sandbox preflight: proves the credentials work and reports what already
 * exists in the sandbox account. Creates nothing.
 *
 *   npm run paypal:preflight
 *
 * Reads .env.sandbox, which is git-ignored and which this script never prints.
 */
import dotenv from "dotenv";
import { safeLog, safeError, tail } from "../src/util/redact";

dotenv.config({ path: ".env.sandbox" });

const SANDBOX_HOST = "https://api-m.sandbox.paypal.com";

// Hard gate. Everything below is destructive-adjacent only in the sense that
// it authenticates; running it against Live would still put Live credentials
// on the wire from a development machine.
const assertSandbox = () => {
  if (process.env.PAYPAL_ENV !== "sandbox") {
    throw new Error(
      `Refusing to run: PAYPAL_ENV must be exactly "sandbox", got "${process.env.PAYPAL_ENV || "(unset)"}".`
    );
  }
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    throw new Error(
      `Missing from .env.sandbox: ${missing.join(", ")}. Fill them in and re-run.`
    );
  }
};

const token = async () => {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${SANDBOX_HOST}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `OAuth failed (${response.status}): ${body.error_description || body.error || "unknown"}`
    );
  }

  return body;
};

const get = async (path, accessToken) => {
  const response = await fetch(`${SANDBOX_HOST}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${path} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
};

const run = async () => {
  assertSandbox();

  safeLog("=== 1. OAuth ===");
  const auth = await token();
  // Never the token itself - only that one was issued and for how long.
  safeLog(
    `  obtained an access token: yes  (expires_in=${auth.expires_in}s, type=${auth.token_type}, scopes=${String(auth.scope || "").split(" ").filter(Boolean).length})`
  );
  safeLog(`  app id: ${auth.app_id || "(not reported)"}`);

  safeLog("\n=== 2. Existing sandbox catalogue ===");

  const products = await get("/v1/catalogs/products?page_size=20", auth.access_token);
  const productList = products.products || [];
  safeLog(`  products: ${productList.length}`);
  for (const product of productList) {
    safeLog(`    - ${product.id}  "${product.name}"  (${product.type || "?"})`);
  }

  const plans = await get("/v1/billing/plans?page_size=20", auth.access_token);
  const planList = plans.plans || [];
  safeLog(`  plans: ${planList.length}`);
  for (const plan of planList) {
    safeLog(
      `    - ${plan.id}  "${plan.name}"  status=${plan.status}  product=${plan.product_id}`
    );
  }

  const looksLikeOurs = (value) => /aicontact/i.test(value || "");
  const existingProduct = productList.find(
    (p) => looksLikeOurs(p.name) || looksLikeOurs(p.id)
  );
  const existingPlan = planList.find(
    (p) => looksLikeOurs(p.name) || (existingProduct && p.product_id === existingProduct.id)
  );

  safeLog("\n=== 3. Verdict ===");
  if (existingProduct && existingPlan) {
    safeLog(`  An AICONTACT product and plan already exist.`);
    safeLog(`  product: ${existingProduct.id}`);
    safeLog(`  plan:    ${existingPlan.id}   <- put this in PAYPAL_PLAN_IDS`);
    safeLog(`  Nothing needs creating.`);
  } else {
    safeLog(
      `  ${existingProduct ? "A product exists but no matching plan." : "No AICONTACT product or plan exists."}`
    );
    safeLog(`  Proposed configuration is printed below. NOTHING HAS BEEN CREATED.`);
    safeLog(`  Creating these requires explicit approval - see scripts/paypal-sandbox-create-catalogue.js\n`);

    safeLog("  --- product ---");
    safeLog(
      JSON.stringify(
        {
          name: "AICONTACT",
          description: "AICONTACT eye-contact correction subscription",
          type: "SERVICE",
          category: "SOFTWARE",
        },
        null,
        2
      )
    );

    safeLog("\n  --- monthly plan ---");
    safeLog(
      JSON.stringify(
        {
          product_id: existingProduct ? existingProduct.id : "<product id from above>",
          name: "AICONTACT Monthly",
          description: "AICONTACT monthly subscription",
          status: "ACTIVE",
          billing_cycles: [
            {
              frequency: { interval_unit: "MONTH", interval_count: 1 },
              tenure_type: "REGULAR",
              sequence: 1,
              // 0 = renews until cancelled
              total_cycles: 0,
              pricing_scheme: {
                fixed_price: { value: "<price>", currency_code: "<currency>" },
              },
            },
          ],
          payment_preferences: {
            auto_bill_outstanding: true,
            setup_fee_failure_action: "CONTINUE",
            payment_failure_threshold: 3,
          },
        },
        null,
        2
      )
    );
    safeLog(
      "\n  Price and currency are deliberately left blank - they must match the Live plan."
    );
  }

  safeLog("\n=== 4. Webhooks ===");
  const hooks = await get("/v1/notifications/webhooks", auth.access_token);
  const hookList = hooks.webhooks || [];
  safeLog(`  registered webhooks: ${hookList.length}`);
  for (const hook of hookList) {
    safeLog(`    - ${hook.id}  ${hook.url}  events=${(hook.event_types || []).length}`);
  }
  if (!hookList.length) {
    safeLog("  None. A publicly reachable HTTPS URL is required to register one.");
  }
};

run().catch((error) => {
  safeError(`\npreflight failed: ${error.message}`);
  process.exit(1);
});
