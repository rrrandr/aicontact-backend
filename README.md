# AICONTACT backend

Express + MongoDB API behind the AICONTACT applications.

Two API versions run side by side. **v1** (`/api/user/*`) is what every
released build talks to and cannot change shape. **v2** (`/api/v2/*`) is the
authenticated replacement, mounted only when `ENABLE_V2` is true.

## Running

```bash
npm install
cp .env.example .env      # set URI at minimum
npm run dev               # nodemon + babel-node
npm start                 # babel-node
```

The process refuses to start if `URI` is missing or the database is
unreachable. That is deliberate: the previous implementation began listening
regardless and reported success either way, so a bad deploy looked healthy
while every request failed.

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness. Always 200 if the process is up. |
| `GET /readyz` | Readiness. 503 unless the database connection is live. |

## v2

Enable with `ENABLE_V2=true`. Every value v2 needs is checked at boot, so a
missing Apple key is a startup failure rather than a failed purchase.

| Endpoint | Notes |
| --- | --- |
| `POST /api/v2/auth/register` | Returns an access + refresh pair |
| `POST /api/v2/auth/login` | Uniform failure; no account enumeration |
| `POST /api/v2/auth/refresh` | Rotates; reuse revokes the whole family |
| `POST /api/v2/auth/logout` | Revokes the presented refresh token |
| `POST /api/v2/auth/password/forgot` | Always 202 |
| `POST /api/v2/auth/password/reset` | Single use; ends every session |
| `GET /api/v2/me` | Profile plus computed entitlement |
| `PATCH /api/v2/me` | Terms acceptance only |
| `DELETE /api/v2/me` | Account deletion; password required again |
| `GET /api/v2/entitlements` | Authoritative state |
| `POST /api/v2/entitlements/apple/verify` | Verifies with Apple |
| `POST /api/v2/entitlements/paypal/link` | Binds a subscription to one account |
| `POST /api/v2/webhooks/apple` | Server Notifications V2 |
| `POST /api/v2/webhooks/paypal` | Subscription lifecycle |
| `GET /config` | Unauthenticated, signed, cacheable |

### Entitlements are server-owned

No request handler writes entitlement state from client input. Rows in
`entitlements` are created and updated only by provider verification and
provider webhooks, and expiry is computed on the server. `PATCH /api/v2/me`
rejects entitlement fields outright rather than ignoring them.

### Apple

Two independent checks, both required. The signed transaction's certificate
chain is validated back to a **pinned** Apple root and its signature verified;
then current state is read from the App Store Server API. A valid signature
only proves a purchase happened at some point — it says nothing about whether
it was since refunded, revoked, or allowed to lapse.

`APPLE_ROOT_CERTS` has no default. With no root configured, verification
refuses to run rather than trusting an unpinned chain.

**Environment is taken from the host that answered**, never from the
`environment` field in the response body, and a Sandbox result is refused
unless `APPLE_ALLOW_SANDBOX` is on. Sandbox and TestFlight purchases cost
nothing, so accepting them in production makes the service free to anyone who
can build the app. The check is applied on every read as well as at creation,
so a row written while sandbox was permitted stops granting access the moment
it is not.

`APPLE_PRODUCT_IDS` restricts which products grant entitlement, and the
transaction is selected by original transaction id rather than by taking the
first one Apple returns.

The client must be on **Unity IAP 5.x** to produce StoreKit 2 signed
transactions; 4.11.0 emits legacy receipts this endpoint does not accept.

### PayPal

Credentials live only in the environment.

**A subscription id does not establish ownership.** It appears in receipts,
customer emails and PayPal's own interface, so anyone who learns one could
otherwise claim the entitlement. Ownership comes from `custom_id`, which the
server sets when it creates the subscription (`POST
/api/v2/entitlements/paypal/subscription`) and PayPal echoes back on lookup.
`POST /api/v2/entitlements/paypal/link` refuses anything else.

Subscriptions created before that existed are claimed through a separate
verified path, enabled by `PAYPAL_LEGACY_CLAIM_ENABLED` and confirmed by a
code sent to the address PayPal holds for the subscriber — not one the caller
supplies. Turn it on for a supervised migration window, then off.

Renewals are handled: `PAYMENT.SALE.COMPLETED` and the subscription lifecycle
events all trigger an authoritative re-read from PayPal, so `next_billing_time`
cannot go stale and strand a paying subscriber.

### Deletion and billing

Account deletion cancels a linked PayPal subscription and then **confirms with
PayPal that it actually stopped** before destroying anything. An unconfirmed
cancellation aborts the deletion with a 503 and records a durable job in
`pending_cancellations`, retried by the maintenance loop. Completing the
deletion while billing continued would detach the person from a subscription
they can no longer sign in to stop.

A PayPal 422 is not read as success: it covers several conditions, only one of
which is "already inactive". What settles it is reading the subscription back.

### Retention

`purgeExpiredRecords` actually deletes, on a schedule started with the server —
audit rows past `RETENTION_AUDIT_DAYS`, detached financial records past
`RETENTION_FINANCIAL_DAYS`. Records still attached to a live account are never
touched. The periods themselves still need legal sign-off.

### Concurrency

Ownership claiming, refresh-token rotation and password-reset consumption are
all single-winner: the condition lives in the update filter rather than in a
read that precedes it. `tests/v2/concurrency.test.js` fires genuinely parallel
requests at each.

Refresh rotation has a short grace window (`REFRESH_REUSE_GRACE_MS`) during
which a second presentation of a just-rotated token is treated as a concurrent
duplicate rather than a replay — a client with two screens open would otherwise
be signed out. It does not weaken reuse detection: the loser gets no token
either way, so the window only decides whether to destroy the session as well.
Only a rotation sets `replaced_by`, so tokens revoked by logout, password reset
or family revocation stay a hard failure.

### Coexistence with v1

Both versions share one `users` collection, so an account works on either. When
v2 grants an entitlement it also writes a derived `users.subscription_date`, so
a user who upgrades on one device is not locked out on another still running a
released build.

That value is derived by working backwards from the authoritative expiry
(`expires_at` minus 30 days, capped at the present), because released clients
compute `30 - (now - subscription_date).Days`. Writing the subscription's
original start date would read as expired for anyone more than one billing
period old — which is every renewing subscriber.

With `V1_ENTITLEMENT_READONLY=true`, v1's `PATCH /update` stops accepting
`subscription_date` for accounts that have a server-owned entitlement. It still
returns success, so released clients are unaffected, and the unauthenticated
grant closes for that account. It closes for everyone only when v1 retires.

### Retiring v1

Not with an error status. Because released clients retry any non-2xx forever,
v1's terminal state has to be a success-shaped response carrying an upgrade
message.

## Tests

```bash
npm test              # everything
npm run test:contract # the v1 wire contract only
```

`tests/contract` is the important one. It replays a fixed request script
against the current code and requires the result to match
`tests/golden/v1-responses.json`, which was recorded by running the original
implementation (commit `0798a00`). Only the deviations enumerated at the top
of `tests/contract/v1-contract.test.js` are permitted; anything else fails.

To re-record the golden file — needed only if the request script gains a case:

```bash
./scripts/record-v1-golden.sh
```

## Why v1 endpoints are treated so carefully

Three completion handlers in the released Unity client re-issue their request
immediately when it fails, with no backoff and no attempt cap:

```
InAppPurchaseScreenHandler.cs:159-162       GetUser    -> GetUser
InAppPurchaseScreenHandler.cs:315-318       UpdateUser -> UpdateUser
TermsAndConditionsScreenHandler.cs:104-107  UpdateUser -> UpdateUser
```

`UnityWebRequest.Result` treats every 4xx and 5xx as a failure, so **any**
non-2xx from `GET /api/user/:email` or `PATCH /api/user/update` puts installed
applications into a hot loop against this server.

Two consequences run through the code:

- Rate limiting is split. `/login` and `/register` reject with 429, because
  their failure path in the client stops and shows a message. The other two
  endpoints use `src/middlewears/throttle.js`, which applies backpressure by
  delaying the response and only ever rejects at a circuit-breaker ceiling far
  above legitimate use.
- v1 can never be retired with an error status. Its terminal state has to be a
  success-shaped response carrying an upgrade message.

## Known-open issue

`PATCH /api/user/update` is unauthenticated. Anyone who knows an email address
can grant that account a subscription with one request. It cannot be closed
without breaking released clients, so for now every entitlement write is
recorded to the `entitlement_audits` collection for review. It closes
progressively in v2 and fully when v1 retires.

## Outstanding decisions

- **Retention periods** (`RETENTION_FINANCIAL_DAYS`, `RETENTION_AUDIT_DAYS`)
  are placeholders. They need legal sign-off for your jurisdiction.
- **No email provider is configured.** `MAIL_PROVIDER=log` only writes a log
  line, so password reset does not actually send. Adapters for Resend and
  Postmark are present; pick one and set `MAIL_PROVIDER_KEY`.
- **Mongoose 6 is past end of life.** It is kept here because the production
  server version is unknown; upgrading needs that answer first.
- **The desktop builds have no account model.** Until they gain one, server-
  owned entitlements cannot apply to Mac and Windows.

## Migration

```bash
npm run backfill:email-norm            # report only
npm run backfill:email-norm -- --apply # write
```

Populates `users.email_norm` for rows created before the field existed. It is
additive and idempotent — the stored `email` is never modified — so rolling
the code back needs no data restore. Case-collisions are reported, never
merged: two accounts differing only in case are a product decision.

Take a database snapshot first.

## Deployment

`.gitlab-ci.yml` is a leftover from a GitLab pipeline and does nothing on
GitHub. There is currently no CI/CD attached to this repository, and
production runs on infrastructure reached at `snapcamera-be.invo.zone`.
Deployment is deliberately untouched here.
