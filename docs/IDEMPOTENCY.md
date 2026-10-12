# Idempotency and execution guarantees of `POST /v1/jobs`

This document states what the gateway guarantees about submitting and running
a job, what it does not, how it can fail, and which of these claims have been
checked and where. Distributed exactly-once execution is **not** claimed.

## Summary

| Layer | Guarantee | Mechanism |
|---|---|---|
| Creating a job | At most one job per `(account, Idempotency-Key)` | Unique constraint `uq_jobs_owner_idempotency_key` on `(owner_id, idempotency_key)` (`db/models.py`) plus the `v2:` request fingerprint |
| Running a job in the gateway | At most one live execution at a time | A single conditional `UPDATE ... WHERE state = 'queued'` claims the job; the claim is a 60 s lease renewed every 20 s (`jobs/leases.py`) |
| Delivering work | At least once | The database row is the source of truth; Redis messages may be duplicated or lost and queued rows are republished (`job_dispatch.py`) |
| Effects on a remote Engine | At least once | An Engine can see the same job again after a crash or a lost lease |
| End to end | **Not** exactly once | See [failure modes](#failure-modes) |

## Scope of the key

An `Idempotency-Key` (1–255 characters) is scoped to the **account**: two
accounts may use the same key and get independent jobs. A job is never visible
across accounts. Submitting a job requires an account (`401 unauthorized`
otherwise); every accepted job is persisted.

## What the key identifies

The key is bound to the **canonical request**, not to what the gateway resolved
from it. The fingerprint is `v2:` + the canonical digest of
`{source, body, configuration}` (`domain/idempotency.py`):

- `source`: digest of the package (uploaded, or the snapshot's archive);
- `body`: the JSON body exactly as the client sent it;
- `configuration`: the pinned ExecutionConfiguration reference, if any.

It is 74 characters long and is stored in `jobs.idempotency_fingerprint`
(`String(80)`). Because it describes what the client **sent**, it does not change
when the gateway resolves differently between two identical submissions, for
example options trimmed by the caller's plan.

## Behaviour

- Same key, same canonical request: replay. The response is `202` with the
  original job `id`, its current `status`, and `"idempotent": true`. No new job
  is created and nothing is dispatched.
- Same key, different request: `409 idempotency_conflict`.
- Concurrent requests with one key: the account row is locked
  (`jobs/limits.lock_owner`, `FOR UPDATE`) before the check, so a request that
  waited behind the one that created the job sees it and replays. The unique
  constraint is the last line of defence: the loser of an `IntegrityError`
  re-reads the winner and replays (`_raced_idempotent_outcome` in
  `routes/v1.py`).
- A request without an `Idempotency-Key` has no replay protection: each one
  creates a job.
- A study cell has its own unique index (`uq_jobs_study_cell_id`): a second
  launch of the same cell returns the winning job.
- A replay does not take a concurrency slot: the concurrency check runs after
  the replay has been ruled out (`jobs/limits.py`).

Retention: a key lives as long as its job. There is no separate expiry; deleting
the job frees the key.

Legacy rows written before the `v2:` scheme hashed the *resolved* request, so
they can only be compared after resolving; they are compared with the old
algorithm and replay or conflict as before.

## Execution

1. **Claim.** `claim_job` moves a `queued` job to `running` with a lease token,
   `lease_until = now + 60 s` and `attempt + 1`. Of two workers claiming the same
   job exactly one finds it still queued; the other gets nothing and returns
   without doing anything. This is why a duplicated queue message is harmless.
2. **Heartbeat.** The worker renews the lease every 20 s on its own connection.
   One missed beat is survivable (the lease allows three).
3. **Outcome.** Before writing a result, a failure or a cancellation the worker
   calls `hold_lease`, which locks the row and checks that it is still `running`
   with the worker's token. A worker that lost its lease writes nothing.
4. **Recovery.** The reconciler (`jobs/reconciler.py`, every 60 s) finds jobs
   whose lease has lapsed. The first time (`attempt < 2`) the job goes back to
   `queued`; the second time it is `failed`. A job without a lease is failed
   after its requested budget plus 120 s. Updates are conditioned on the state
   read, so a heartbeat or claim that lands in between wins.
5. **Redelivery.** With `JOB_DISPATCH_MODE=dramatiq` the job is published to
   Redis after the commit. If publishing fails, the row stays `queued` and the
   reconciler republishes queued rows older than 30 s (`redeliver_queued_jobs`).
   Dramatiq retries the actor up to 5 times for failures before the claim.
   `JOB_DISPATCH_MODE=inline` (tests, single-process development) runs the same
   runner in the request.
6. **Study cells.** A cell is synchronised when its job changes state, and the
   reconciler resyncs the cells of terminal jobs that never reached theirs
   (`_resync_study_cells`).

## Failure modes

| Failure | Result |
|---|---|
| Duplicate queue message | Second claim finds the job not `queued` and does nothing |
| Redis down after commit | `202` is still returned; the job stays `queued` and is republished later |
| Message lost after commit | Same: the periodic republication covers it |
| Worker dies mid-solve | Lease lapses; the job runs again once, then fails. **The Engine may have run the first attempt to completion or partly** |
| Worker is slow, not dead, and loses its lease (clock skew beyond ~40 s, long pause) | The job may be requeued and run a second time; the first worker's late answer is discarded by `hold_lease`. The Engine did the work twice |
| Gateway restarts between the Engine's answer and the database commit | The result is lost for that attempt; the job is requeued or failed by the reconciler |
| Client retries after a timeout with the same key | Replay of the original job |
| Client retries with a new key (or none) | A new job; nothing links it to the first |

Consequently **Engines must tolerate seeing the same job more than once**. A
remote Engine's side effects are at least once and the gateway cannot make them
exactly once. The platform's own reads are protected by re-evaluation: a result
is accepted only after OpenBinding recomputes it from the IR, so a duplicate run
cannot change the recorded decision, but it can cost compute.

## What is certified

- The logic above is covered by the gateway test suite, which runs on
  **SQLite in memory** by default (`tests/conftest.py`, `db_session`). SQLite
  has no row locks: `FOR UPDATE` and `SKIP LOCKED` are accepted and ignored,
  so on SQLite the concurrency check is the plain count and the claim race is
  decided by the single `UPDATE`.
- **Not executed against a real PostgreSQL yet.** A concurrency harness exists
  (`openbinding-gateway/tests/concurrency/*_pg.py`, `compose.pgtest.json`,
  [`qa/PG_HARNESS.md`](qa/PG_HARNESS.md)) for row locks, `SKIP LOCKED` and the
  partial unique indexes, but it has never been run: expect surprises on the
  first execution. The suite can also be pointed at PostgreSQL with
  `TEST_DATABASE_URL`, which has not been done either. Until then the behaviour
  under concurrent PostgreSQL transactions is an engineering expectation, not a
  certified property.
- Not exercised: Redis broker failures against a real Redis, remote Engines
  under crash injection, clock skew.

Related: [ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md) (the concurrency cap),
[ARCHITECTURE.md](ARCHITECTURE.md) (where `jobs/` sits), and
[qa/JOINT_STATUS.md](qa/JOINT_STATUS.md).
