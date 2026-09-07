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

`APPLE_PRODUCT_IDS` restricts which products grant entitlement and is
**required** when v2 is enabled — the server refuses to start without it, and
an empty list is treated as a refusal rather than a wildcard, so a missing or
mistyped setting cannot silently disable the control. The transaction is
selected by original transaction id rather than by taking the first one Apple
returns.

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

### Cancelling a subscription

`POST /api/v2/entitlements/paypal/cancel` stops future renewals for the
authenticated account. It takes **no subscription id**: the server cancels
whatever is linked to the caller, so there is no request shape that could name
somebody else's subscription. PayPal's `custom_id` binding is re-checked as an
independent second proof.

The order matters. The subscription is read from PayPal **before** it is
cancelled, because `billing_info.next_billing_time` is the date access has been
paid through — the trial's scheduled end while the trial runs, the end of the
paid month afterwards — and PayPal clears it the moment the subscription is
cancelled. That date is stored as `access_ends_at` on both the entitlement and
the `paypal_subscriptions` row, and access continues until it. Cancelling
during the trial therefore preserves the trial's own end and does not hand out
a paid month.

`access_ends_at` is then a **floor**. `upsertEntitlement` will not write an
expiry earlier than it, and turns the `expired` status a cancellation
notification implies back into `active` while the date is still ahead. Without
that, the `BILLING.SUBSCRIPTION.CANCELLED` webhook — which arrives seconds
later carrying no billing date at all — would revoke a period the subscriber
paid for, and would do it again on every provider retry. Only `refunded` and
`revoked` are allowed past the floor, because those are statements that the
period was not paid for after all.

Cancellation is **idempotent by record, not by request**. A second click finds
`cancelled_at` already set, returns `already_cancelled: true` with a 200, and
does not reach PayPal — which matters, because re-deriving the access-end date
at that point would replace a real date with nothing. The `Idempotency-Key`
header is honoured as well, but it is not what makes a second click safe.

**Failure is closed.** Unless PayPal's own record confirms the subscription is
no longer billing, the endpoint returns 503 `cancellation_unconfirmed`, writes
nothing locally, and records a `pending_cancellations` job for the same
maintenance loop that covers deletion. Telling someone they had cancelled
because a local write succeeded is the one outcome worth failing loudly over.

Cancelling never touches the account. Feedback is a separate call
(`POST /api/v2/entitlements/paypal/cancel/feedback`) that is only accepted
*after* a cancellation is recorded, so it can never become a step on the way to
cancelling; both its fields are optional.

### Deletion and billing

Account deletion cancels a linked PayPal subscription and then **confirms with
PayPal that it actually stopped** before destroying anything. An unconfirmed
cancellation aborts the deletion with a 503 and records a durable job in
`pending_cancellations`, retried by the maintenance loop. Completing the
deletion while billing continued would detach the person from a subscription
they can no longer sign in to stop.

A PayPal 422 is not read as success: it covers several conditions, only one of
which is "already inactive". What settles it is reading the subscription back.

Only `CANCELLED`, `EXPIRED`, or a subscription PayPal no longer has satisfies
deletion. **`SUSPENDED` does not** — suspension pauses collection but leaves
the billing agreement in place and it can be reactivated.

### The weekly owner summary

One message a week instead of one per signup and one per cancellation. Off by
default (`WEEKLY_REPORT_ENABLED=false`, `OWNER_REPORT_TO` empty), so upgrading
the code sends nothing.

Every number comes from a durable database record. Registrations are counted
from the account's own `_id`, whose embedded timestamp survives the tombstoning
deletion applies, and deletions from `users.deleted_at` — both already existed,
so nothing new is stored for them. Only the two moments nothing recorded needed
new fields: `paypal_subscriptions.activated_at`, written once when PayPal first
reports a subscription live, and `cancelled_at` with `cancellation_source`.
Trial and paid counts come from `phase`, taken from PayPal's own cycle
bookkeeping rather than guessed from dates; subscriptions linked before that
field existed are reported on their own line rather than folded into either
bucket.

The window runs Monday 09:00 to Monday 09:00 in `WEEKLY_REPORT_TIMEZONE`,
computed in local time on both ends so consecutive weeks abut exactly across
the two clock changes a year. Every instant during a week resolves to the same
window, which is what makes delivery idempotent: the window is the unique key
of the `weekly_reports` row, so a retry, a restart or a second process finds
the week already sent and does nothing. A delivery that fails is kept, marked
`failed`, and retried with the same window rather than skipped.

The message carries counts only — no addresses, no identifiers, no credentials
— and its subject reads "AICONTACT weekly billing summary", so it is not
mistaken for an outage alarm arriving at the same address.

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

Refresh rotation writes `revoked_at` and `replaced_by` in a **single**
conditional update. Setting them separately leaves a window where the token
looks revoked with no successor — indistinguishable from a deliberate
revocation — and a loser arriving there would revoke the family the winner had
just created. If the successor cannot then be written, the consumption is
compensated so the presented token stays usable.

Rotation has a short grace window (`REFRESH_REUSE_GRACE_MS`) during which a
second presentation of a just-rotated token is treated as a concurrent
duplicate rather than a replay — a client with two screens open would otherwise
be signed out. It does not weaken reuse detection: the loser gets no token
either way, so the window only decides whether to destroy the session as well.
Only a rotation sets `replaced_by`, so tokens revoked by logout, password reset
or family revocation stay a hard failure.

### Single-use codes

Password reset and legacy PayPal claiming take a short **processing lease**
rather than marking the code used up front. Marking first and working after
spends the code whenever the work fails — leaving a user with an unchanged
password and a dead reset link. The code is settled only once the work has
succeeded, and the lease is released if anything goes wrong.

### Why there are no transactions

**The current configuration appears to be standalone, so transactions are
assumed unavailable — but this has not been verified against the server.**
The connection strings in the developer handover are plain `mongodb://` with a
single host, no `+srv`, and no `replicaSet` option, which is consistent with a
self-hosted server on the box the pipeline deploys to. That is evidence, not
proof: a single-host URI can still address a replica-set member.

The definitive check is to ask the server. Against the deployment (credentials
from the environment, never pasted anywhere):

```bash
mongosh "$URI" --quiet --eval 'const h = db.hello(); print(h.setName ? "replica set: " + h.setName : "standalone")'
```

If that reports a replica set, transactions are available and refresh
rotation, password reset and legacy claim completion are the three flows worth
revisiting with real ones — the fencing and family state below would then be
belt and braces rather than the primary mechanism.

Until then, the flows that would otherwise need a transaction are built so
they do not:

- **Fenced leases.** Every lease acquisition carries a random `lease_token`,
  and settle and release both require it. A worker whose lease went stale
  cannot mark its successor's work finished or clear an active lease.
- **Durable family revocation.** `token_families` records revocation for a
  whole refresh lineage. A rotation that stalls past the grace window and
  lands its successor after the family was revoked cannot resurrect the
  session: rotation checks family state before and after writing, so both
  orderings converge on a revoked outcome.
- **A self-guarding security transition.** The password write is a single
  conditional update on the User document that matches only while
  `password_reset_token_hash` is not this token, and sets the password, the
  marker and `token_version` together. The reset record's lease coordinates
  the workflow but is never the authority over a different document, so a
  worker whose lease went stale still cannot write a password.
- **Family-first revocation.** `revokeAllForUser` marks every family for the
  account dead before touching token rows, so a rotation already in flight
  cannot land a successor into a lineage nobody revoked. Password reset and
  account deletion both go through it.

### Sessions belong to a credential generation

One invariant ties the session lifecycle together: **a refresh-token family
belongs to the `User.token_version` it was created under.**

`token_families` records that version at creation, and rotation compares it
against the account's current one, revoking the family when they differ. This
is what catches a session that was never explicitly revoked but is stale
anyway — a login that verifies the old password, stalls, and creates its
family *after* a password reset has already enumerated and revoked everything.
Its access token fails on `token_version`; without the family check its
refresh token would still mint a valid one.

Three consequences follow from the same rule:

- **Logout revokes the family**, resolving the presented token even when a
  rotation has already consumed its row. Revoking only that row does nothing
  once it is spent, leaving the successor usable.
- **Refresh signs from the generation it validated.** The access token is
  built from the account snapshot rotation checked the family against, never
  from a later read. Re-reading would rebase the session onto whatever
  generation exists by then, handing a valid post-reset token to a session
  whose family had just been revoked. Account deletion has no equivalent
  boundary — it mints no credential.
- **A successful password reset ends every outstanding reset link.** Each link
  records the credential generation it was issued under, and the conditional
  User update requires the account to still be at that generation. Any
  successful reset increments `token_version`, so every sibling link goes
  stale — in either order, and without inferring ordering from millisecond
  timestamps. A timestamp condition is kept as a secondary guard, and
  outstanding records are marked used as belt and braces.
- **The transparent bcrypt rehash at login is a conditional update**, applied
  only while the stored hash is still the one just verified. Saving the
  in-memory document instead would write the old password back over a
  concurrent reset. Tokens are still issued from the state the login actually
  authenticated against, so a login that raced a reset records the superseded
  generation and is refused on first use rather than inheriting the new one.

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

## PayPal sandbox integration

Opt-in, and separate from the ordinary test run. `npm test` uses
`jest.config.js`, whose `testMatch` covers `tests/` only, so nothing under
`integration/` is ever picked up by it.

```bash
cp .env.sandbox.example .env.sandbox   # git-ignored; fill in the two secrets
npm run paypal:preflight               # proves OAuth works, reports what exists
npm run test:integration:paypal        # the lifecycle suite
```

The suite is closed by default and fails closed when opened:

| State | Behaviour |
| --- | --- |
| `PAYPAL_SANDBOX_INTEGRATION` unset | Does not run at all |
| Set, but variables missing | **Fails**, naming each missing variable |
| `PAYPAL_ENV` is not `sandbox` | **Fails** — it will not run against Live |
| `PAYPAL_WEBHOOK_ID` unset | Webhook tests **fail** unless `PAYPAL_SKIP_WEBHOOK_TESTS=1` |

A green run therefore cannot mean "the credentials were missing so nothing
happened".

It runs in two phases because buyer approval is a browser step. Phase 1
creates a subscription bound to the account and writes
`.paypal-sandbox-state.json` (git-ignored) with the approval URL. After
approving in the browser with a sandbox **personal** account, set
`PAYPAL_TEST_SUBSCRIPTION_ID` and re-run for phase 2 — linking, ownership,
idempotency, authoritative refresh, cancellation and deletion.

Everything printed by these scripts goes through `src/util/redact.js`, which
strips known secret values, `Authorization` headers, access tokens,
credentialed database URIs, private keys, customer addresses, and shortens
PayPal identifiers.

## Outstanding decisions

- **Retention periods** (`RETENTION_FINANCIAL_DAYS`, `RETENTION_AUDIT_DAYS`)
  are placeholders. They need legal sign-off for your jurisdiction.
- **No email provider is configured.** `MAIL_PROVIDER=log` only writes a log
  line, so password reset does not actually send. Adapters for Resend and
  Postmark are present; pick one and set `MAIL_PROVIDER_KEY`.
- **Mongoose 6 is past end of life.** Both the server version and the topology
  still need confirming from the server itself — see the transactions note
  above for the command.
- **Credentials in the developer handover.** The files delivered by the
  previous developer contain the production database credentials in plaintext.
  They should be rotated, the files removed or securely archived, and the
  replacements kept only in the deployment secret store.
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

### Enabling the weekly owner summary

The report is written and tested but **off, and with its transport set to
`log`, which sends nothing**. Four steps, in this order.

1. **Grant the instance permission to publish.** The summary goes to the
   existing `AICONTACT-Production-Alerts` topic, whose email subscription is
   already confirmed, so nothing new has to be verified and nothing about who
   receives it lives in this repository.

   `infra/weekly-report-sns-publish.yaml` is a CloudFormation stack granting
   one action on one resource: `sns:Publish` on that topic. It cannot create
   topics, subscribe anyone, read subscriber addresses, or publish elsewhere.
   Verify both parameters and review the change set first; see `infra/README.md`.

2. **Set the variables** in `/opt/aicontact/shared/.env`:

   ```
   WEEKLY_REPORT_ENABLED=true
   OWNER_REPORT_TRANSPORT=sns
   OWNER_REPORT_SNS_TOPIC_ARN=arn:aws:sns:us-east-2:851725546085:AICONTACT-Production-Alerts
   OWNER_REPORT_AWS_REGION=us-east-2
   WEEKLY_REPORT_TIMEZONE=America/New_York
   WEEKLY_REPORT_CHECK_INTERVAL_MS=900000
   ```

   `MAIL_PROVIDER` is not involved and does not need changing: it carries
   customer mail, and the two are routed separately on purpose.

3. **There is no cron step.** The summary is driven by the in-process
   maintenance loop started in `index.js`, which ticks every
   `WEEKLY_REPORT_CHECK_INTERVAL_MS` and asks whether the completed week has
   been delivered yet. The Monday 09:00 boundary comes from the window, not
   from when the tick happens, so what this actually requires is that the
   process runs continuously - which PM2 already ensures. A restart at any
   point loses nothing: the window is the key, and a week already sent is
   never sent twice.

   The backend runs on Node 18, so `@aws-sdk/client-sns` is pinned to 3.967.0,
   the last release that still declares Node 18 support. Do not let a routine
   `npm update` move it until the runtime is upgraded; a newer SDK refuses to
   install on Node 18.

4. **Confirm delivery on the first Monday.** A report the transport did not
   send is recorded `status: "failed"` with the reason, not `sent`, and retried
   on the next tick - so a misconfiguration shows up as a stuck row rather than
   a week that vanished:

   ```
   db.weekly_reports.find().sort({period_end: -1}).limit(4)
   ```

   Expect one row per week, `status: "sent"`, `sent_at` set, `attempts: 1`.
   `pm2 logs` also warns at boot if the report is enabled while the transport
   is `log` or has no destination.

To roll back, set `WEEKLY_REPORT_ENABLED=false` and restart. Nothing else
depends on it, and no per-event mail exists to fall back to — there never was
any.
