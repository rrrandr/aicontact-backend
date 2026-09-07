# Purge of stored IP addresses and User-Agent strings

**Not executed. Requires separate approval.**

The code no longer writes these fields (see `no-network-origin.test.js`, which
fails if any schema declares them or any request path persists them). This
covers the rows written before that change.

Run the purge only after the new backend is deployed. Purging first would
refill from the running code.

## 1. Row counts

Not obtained. Production Mongo is reachable only through SSM on
`i-057ae18a360c34da6`, and both AWS profiles are expired. Get them with:

```sh
aws sso login --profile aicontact-sso
aws ssm start-session --target i-057ae18a360c34da6 --profile aicontact-sso
```

then, on the instance:

```js
use snapcamera_db
db.entitlement_audits.countDocuments({ $or: [ {ip: {$exists:true}}, {user_agent: {$exists:true}} ] })
db.refresh_tokens.countDocuments({ user_agent: {$exists:true} })
db.audit_logs.countDocuments({ ip_hash: {$exists:true} })
```

Report those three numbers before proceeding.

## 2. Backup

A full encrypted backup already runs daily to
`aicontact-prod-backups-851725546085-us-east-2`. Take a fresh one first so the
rollback point is minutes old, not hours:

```sh
sudo systemctl start aicontact-mongodb-backup
sudo systemctl status aicontact-mongodb-backup   # confirm it completed
```

Then export just the affected fields, so a restore does not need the whole
database:

```sh
mongoexport --db snapcamera_db --collection entitlement_audits \
  --fields _id,ip,user_agent --out /tmp/purge-backup-entitlement-audits.json
mongoexport --db snapcamera_db --collection refresh_tokens \
  --fields _id,user_agent --out /tmp/purge-backup-refresh-tokens.json
mongoexport --db snapcamera_db --collection audit_logs \
  --fields _id,ip_hash --out /tmp/purge-backup-audit-logs.json
```

Copy all three off the instance before continuing.

## 3. Deletion

`$unset` removes the fields and leaves every row otherwise intact. Nothing is
deleted; the audit trail keeps who did what and when.

```js
db.entitlement_audits.updateMany({}, { $unset: { ip: "", user_agent: "" } })
db.refresh_tokens.updateMany({}, { $unset: { user_agent: "" } })
db.audit_logs.updateMany({}, { $unset: { ip_hash: "" } })
```

## 4. Verification

All three must return 0:

```js
db.entitlement_audits.countDocuments({ $or: [ {ip: {$exists:true}}, {user_agent: {$exists:true}} ] })
db.refresh_tokens.countDocuments({ user_agent: {$exists:true} })
db.audit_logs.countDocuments({ ip_hash: {$exists:true} })
```

And the rows themselves must still be there, with their other fields:

```js
db.audit_logs.countDocuments({})          // unchanged from before
db.audit_logs.findOne({}, { action: 1, subject_id: 1, at: 1 })
```

## 5. Rollback

Only if the purge is judged a mistake. Restore the three fields from the
exports:

```sh
mongoimport --db snapcamera_db --collection entitlement_audits \
  --file /tmp/purge-backup-entitlement-audits.json --mode=merge --upsertFields=_id
mongoimport --db snapcamera_db --collection refresh_tokens \
  --file /tmp/purge-backup-refresh-tokens.json --mode=merge --upsertFields=_id
mongoimport --db snapcamera_db --collection audit_logs \
  --file /tmp/purge-backup-audit-logs.json --mode=merge --upsertFields=_id
```

`--mode=merge` restores the removed fields without touching anything else on
the row. Note that the deployed code will not write them again, so a rollback
restores history only.

## Why the fields go rather than get hashed

A hashed IP address is still information about a person: the address space is
small enough to reverse by brute force, so a hash is pseudonymisation, not
anonymisation, and the Privacy Notice now says so in as many words. No process
in the codebase reads any of these three fields. Rate limiting keeps counts in
memory, keyed by address, and persists nothing.
