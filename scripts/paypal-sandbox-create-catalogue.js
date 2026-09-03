/**
 * Creates the AICONTACT sandbox product and monthly plan. Sandbox only.
 *
 *   npm run paypal:create-catalogue -- --dry-run   # show the request bodies
 *   npm run paypal:create-catalogue                # create
 *
 * Re-running is a no-op: existing resources are found and reused, and each
 * create carries a stable PayPal-Request-Id so PayPal itself would return the
 * original rather than a duplicate.
 *
 * On success the ids are written to .paypal-sandbox-state.json and
 * PAYPAL_PLAN_IDS is updated in .env.sandbox. Neither file is tracked, and
 * this script never prints a credential or a token.
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { safeLog, safeError } from "../src/util/redact";
import {
  assertSandbox,
  productPayload,
  planPayload,
  findExistingProduct,
  findExistingPlan,
  PRODUCT_REQUEST_ID,
  PLAN_REQUEST_ID,
} from "./lib/catalogue";

dotenv.config({ path: ".env.sandbox" });

const HOST = "https://api-m.sandbox.paypal.com";
const STATE_FILE = path.join(process.cwd(), ".paypal-sandbox-state.json");
const ENV_FILE = path.join(process.cwd(), ".env.sandbox");

const PRICE = "4.99";
const CURRENCY = "USD";

const dryRun = process.argv.includes("--dry-run");

const token = async () => {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${HOST}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) throw new Error(`OAuth failed (${response.status})`);
  return (await response.json()).access_token;
};

const api = async (method, urlPath, accessToken, { body, requestId } = {}) => {
  const response = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${urlPath} failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
};

const writeState = (patch) => {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    current = {};
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
};

/**
 * Rewrites one line of .env.sandbox in place. The file is read and written
 * whole but never logged, so the credentials in it are untouched and unseen.
 */
const setEnvValue = (key, value) => {
  const contents = fs.readFileSync(ENV_FILE, "utf8");
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(contents)
    ? contents.replace(pattern, `${key}=${value}`)
    : `${contents.trimEnd()}\n${key}=${value}\n`;
  fs.writeFileSync(ENV_FILE, next);
};

const run = async () => {
  assertSandbox();

  safeLog(`=== AICONTACT sandbox catalogue ===`);
  safeLog(`  host:  ${HOST}`);
  safeLog(`  price: ${PRICE} ${CURRENCY} monthly, renewing until cancelled`);
  safeLog(`  mode:  ${dryRun ? "DRY RUN - nothing will be created" : "CREATE"}\n`);

  const accessToken = await token();

  // --- product -----------------------------------------------------------
  const products = (await api("GET", "/v1/catalogs/products?page_size=20", accessToken))
    .products || [];
  let product = findExistingProduct(products);

  if (product) {
    safeLog(`product: already exists, reusing  ${product.id}`);
  } else {
    const body = productPayload();
    safeLog(`product: POST /v1/catalogs/products`);
    safeLog(`  PayPal-Request-Id: ${PRODUCT_REQUEST_ID}`);
    safeLog(JSON.stringify(body, null, 2));

    if (dryRun) {
      safeLog(`  (dry run - not sent)\n`);
    } else {
      product = await api("POST", "/v1/catalogs/products", accessToken, {
        body,
        requestId: PRODUCT_REQUEST_ID,
      });
      safeLog(`  created: ${product.id}\n`);
    }
  }

  // --- plan --------------------------------------------------------------
  const plans = (await api("GET", "/v1/billing/plans?page_size=20", accessToken)).plans || [];
  let plan = findExistingPlan(plans, product ? product.id : null);

  if (plan) {
    safeLog(`plan: already exists, reusing  ${plan.id}`);
  } else {
    const body = planPayload(
      product ? product.id : "<product id, created above>",
      { price: PRICE, currency: CURRENCY }
    );
    safeLog(`plan: POST /v1/billing/plans`);
    safeLog(`  PayPal-Request-Id: ${PLAN_REQUEST_ID}`);
    safeLog(JSON.stringify(body, null, 2));

    if (dryRun) {
      safeLog(`  (dry run - not sent)\n`);
    } else {
      plan = await api("POST", "/v1/billing/plans", accessToken, {
        body,
        requestId: PLAN_REQUEST_ID,
      });
      safeLog(`  created: ${plan.id}\n`);
    }
  }

  if (dryRun) {
    safeLog(`Dry run complete. Nothing was created.`);
    return;
  }

  writeState({
    product_id: product.id,
    plan_id: plan.id,
    price: PRICE,
    currency: CURRENCY,
    catalogue_created_at: new Date().toISOString(),
  });
  setEnvValue("PAYPAL_PLAN_IDS", plan.id);

  safeLog(`=== recorded ===`);
  safeLog(`  product_id: ${product.id}`);
  safeLog(`  plan_id:    ${plan.id}`);
  safeLog(`  written to .paypal-sandbox-state.json`);
  safeLog(`  PAYPAL_PLAN_IDS updated in .env.sandbox`);
};

run().catch((error) => {
  safeError(`\ncatalogue step failed: ${error.message}`);
  process.exit(1);
});
