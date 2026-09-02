# AICONTACT backend

Express + MongoDB API behind the AICONTACT applications.

Two API versions are planned. **v1** (`/api/user/*`) is what every released
build talks to and cannot change shape. **v2** (`/api/v2/*`) is the
authenticated replacement, not yet implemented.

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
