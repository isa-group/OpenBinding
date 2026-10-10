# Idempotency of `POST /v1/jobs`

## Scope

An `Idempotency-Key` (1–255 characters) is scoped to the **account**: two
accounts may use the same key and get independent jobs. A job is never visible
across accounts.

## What the key identifies

The key is bound to the **canonical request**, not to what the gateway resolved
from it. The fingerprint is `v2:` + the canonical digest of
`{source, body, configuration}`:

- `source`: digest of the package (uploaded, or the snapshot's archive);
- `body`: the JSON body exactly as the client sent it;
- `configuration`: the pinned ExecutionConfiguration reference, if any.

It is 74 characters long and is stored in `jobs.idempotency_fingerprint`.

Because it describes what the client **sent**, it does not change when the
gateway resolves differently between two identical submissions: the engine
picked by `engine: "auto"`, or options trimmed by the caller's plan.

## Behaviour

- Same key, same canonical request: replay. The response is `202` with the
  original job `id`, its current `status`, and `"idempotent": true`. No new job
  is created and nothing is reserved or dispatched.
- Same key, different request: `409 idempotency_conflict`.
- Concurrent requests with one key: the account row is locked while the quota is
  reserved, so a request that waited behind the one that created the job sees it
  and replays. A unique constraint on `(owner_id, idempotency_key)` is the last
  line of defence; the loser releases its reservation and replays.

## Retention

A key lives as long as its job. There is no separate expiry: deleting the job
frees the key.

## Legacy rows

Rows written before this scheme have a fingerprint without the `v2:` prefix. It
hashed the *resolved* request (engine, registration, effective options, ...), so
it can only be compared after resolving. Those rows are compared with the old
algorithm and replay or conflict as before.

## Not guaranteed

Idempotency applies to job **creation** in the gateway. Exactly-once delivery to
a remote engine is **not** guaranteed: a dispatch can be retried after a crash or
lease expiry, so engines must tolerate seeing the same job more than once.

## Accounts only

Submitting a job requires an account (`401 unauthorized` otherwise); the
in-memory path is gone, so every accepted job is persisted and idempotent.
