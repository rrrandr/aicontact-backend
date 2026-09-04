import { config } from "../../config/env";

/**
 * Where PayPal sends the browser after approval or cancellation.
 *
 * These are ordinary HTTPS pages, not a custom URI scheme. A deep link would
 * hand control back to the app automatically, but it also fails silently when
 * the scheme is not registered - on desktop browsers, in-app browsers, or after
 * a reinstall - and the user is left on a dead page with a live subscription.
 *
 * So the page simply tells the person to switch back to AICONTACT. The app then
 * asks the server what actually happened, which is the only account of the
 * subscription that can be trusted anyway.
 *
 * Deliberately unauthenticated: the browser arriving here carries no app
 * session. Nothing is decided here and no state is written; entitlement comes
 * from PayPal's webhook and is read back through GET /entitlements.
 */

const page = (title, heading, body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background:#f5f6f8; color:#14202c; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#0f1720; color:#e6edf3; } }
  main { max-width:32rem; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 .75rem; }
  p { margin:0 0 1rem; }
  .hint { font-size:.9rem; opacity:.75; }
</style></head>
<body><main>
<h1>${heading}</h1>
${body}
<p class="hint">You can close this page.</p>
</main></body></html>`;

export const billingReturn = (req, res) => {
  res.status(200).type("html").send(
    page(
      "Subscription approved",
      "Thanks &mdash; that's approved",
      `<p>Switch back to <strong>AICONTACT</strong> and choose
        <strong>I've approved PayPal</strong> to finish setting up your subscription.</p>`
    )
  );
};

export const billingCancel = (req, res) => {
  res.status(200).type("html").send(
    page(
      "Subscription not started",
      "No subscription was started",
      `<p>Nothing has been charged. Switch back to <strong>AICONTACT</strong>
        if you would like to try again.</p>`
    )
  );
};

/** Exposed so the create-subscription call and these routes cannot drift apart. */
export const configuredReturnUrls = () => ({
  returnUrl: config.paypal.returnUrl,
  cancelUrl: config.paypal.cancelUrl,
});
