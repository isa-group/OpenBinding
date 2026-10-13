# Idempotency and execution guarantees of `POST /v1/jobs`

This document states what the gateway guarantees about submitting and running
a job, what it does not, how it can fail, and which of these claims have been
checked and where. Distributed exactly-once execution is **not** claimed.

## Guarantees

| | Guarantee | Mechanism |
|---|---|---|
| **G1** | At most one job per `(account, Idempotency-Key)` | Unique constraint `uq_jobs_owner_idempotency_key` on `(owner_id, idempotency_key)` (`db/models.py`) plus the `v2:` request fingerprint |
| **G2** | One *current* execution per lease | A single conditional `UPDATE ... WHERE state = 'queued'` claims the job under a 60 s lease renewed every 20 s (`jobs/leases.py`). **Two solves can run in parallel** (a worker presumed dead that is in fact alive, and its replacement) until the old holder's next `hold_lease`; its result is then **discarded** |
| **G3** | The queue is at-least-once | The `queued` row is the outbox. Messages may be duplicated or lost; the publisher republishes due rows (`jobs/publisher.py`) and the claim makes duplicates harmless |
| **G4** | Effects on remote Engines are at-least-once | An Engine can see the same job again after a crash or a lost lease. Mitigated, not removed: idempotency *hints* in request headers and best-effort cancellation of the remote job |
| End to end | **Not** exactly once | See [failure modes](#failure-modes) |

## Where the flow lives

The submission flow is `services/job_submission.py` (`JobSubmission.submit`); the
route (`create_job` and `_create_job_core` in `routes/v1.py`) only reads the
request into a `JobSubmissionInput`, calls the service, dispatches a job it
reports as `created` (after the commit, so a crash still never loses the job) and
translates the `JobSubmissionResult` (`created`, `replay` or `problem`) into a
response. The service does the lookup of the key, the account lock, the
fingerprint comparison (current and legacy), the concurrency check, the
`IntegrityError` race handling and the persistence of the snapshot and the job.
Moving the code changed none of G1-G4 or of the wire contract; the unit tests of
the service are `tests/test_job_submission_service.py`, and the HTTP-level ones
are `tests/test_idempotency_jobs.py` and `tests/concurrency/test_jobs_idempotency_pg.py`.

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

## Behaviour (G1)

- Same key, same canonical request: replay. The response is `202` with the
  original job `id`, its current `status`, and `"idempotent": true`. No new job
  is created and nothing is dispatched.
- Same key, different request: `409 idempotency_conflict`.
- Concurrent requests with one key: the account row is locked
  (`jobs/limits.lock_owner`, `FOR UPDATE`) before the check, so a request that
  waited behind the one that created the job sees it and replays. The unique
  constraint is the last line of defence: the loser of an `IntegrityError`
  re-reads the winner and replays (`_raced_idempotent_outcome` in
  `services/job_submission.py`).
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

## The clock (`jobs/clock.py`)

A lease written with one host's clock and judged with another's expires early on
a host that runs ahead. On **PostgreSQL** every timestamp that takes part in a
lease, a publication or a queue-limit decision is the database's: `now()` and
interval arithmetic (`now() + make_interval(...)`) inside the same `UPDATE` or
`SELECT` that reads or writes the column. This covers `claim_job`, `renew_lease`,
`hold_lease`, the reconciler's requeue / fail / queue-timeout statements,
`sweep_abandoned` (its "now" is read from the database) and the publisher. The
analysis tasks (`analysis_jobs.py`) use the same helpers.

`now()` is the start time of the *transaction*. Every statement above runs in a
short transaction of its own (the heartbeat opens a session per beat), so the
value is current; inside the sweep's longer transaction it is slightly old, which
errs towards not expiring a lease.

On **SQLite** (tests and single-process development) the helpers use the Python
clock through `clock.utcnow`, which tests replace to freeze or move time. A
process clock skewed by minutes therefore cannot requeue a live lease or publish
early on PostgreSQL; this is only checked by the PG tests listed below.

## Execution (G2)

1. **Claim.** `claim_job` moves a `queued` job to `running` with a lease token,
   `lease_until = now + 60 s`, `claimed_at = now` and `attempt + 1`, in one
   statement. Of two workers claiming the same job exactly one finds it still
   queued; the other gets nothing and returns without doing anything. This is why
   a duplicated queue message is harmless.
2. **Heartbeat.** The worker renews the lease every 20 s on its own connection.
   One missed beat is survivable (the lease allows three). The same heartbeat
   (`leases.start_beat`) renews the lease of an analysis task from a background
   task, not only when the computation reports progress.
3. **Outcome.** Before writing a result, a failure or a cancellation the worker
   calls `hold_lease`: one `UPDATE ... WHERE state = 'running' AND lease_token =
   :token` that takes the row lock and pushes the deadline forward. The *token*
   decides ownership, not the deadline: a lapsed lease the reconciler has not yet
   acted on is still the worker's, and the lock stops the reconciler from acting
   until the outcome is committed. A worker whose job was already put back has no
   token any more, gets no row, and writes nothing: **its result is discarded**.
   Between losing the lease and calling `hold_lease` the old worker may still be
   solving, so for that interval two solves run in parallel (G2).
4. **Recovery.** The reconciler (`jobs/reconciler.py`, every 60 s) finds running
   jobs whose lease has lapsed. The first time (`attempt < 2`) the job goes back
   to `queued` with `next_publish_at = now` (due for publication at once); the
   second time it is `failed`. A running job without a lease is failed after its
   requested budget plus 120 s. Updates are conditioned on the state read, so a
   heartbeat or claim that lands in between wins.
5. **Study cells.** A cell is synchronised when its job changes state, and the
   reconciler resyncs the cells of terminal jobs that never reached theirs
   (`_resync_study_cells`). A job failed by the queue limit syncs its cell.

## Publication and the queue (G3)

`JOB_DISPATCH_MODE=inline` (tests, single-process development) runs the runner
inside the request. With `JOB_DISPATCH_MODE=dramatiq`:

- **Immediate publication.** `POST /v1/jobs` and retry commit the `queued` row
  and then send the message. This is unchanged and is the normal path. It is
  *after* the commit, so a crash or a Redis outage can lose the message but never
  the job.
- **The row is the outbox.** `jobs.publish_attempts` (default 0) and
  `jobs.next_publish_at` (null until the first republication; migration
  `f2a3b4c5d6e7`). The reconciler's safety net (`jobs/publisher.py`,
  `redeliver_queued_jobs`) claims a batch with one statement:

  ```sql
  UPDATE jobs SET publish_attempts = publish_attempts + 1,
                  next_publish_at = now() + make_interval(secs => LEAST(300, 15 * 2^LEAST(publish_attempts, 10)))
  WHERE id IN (SELECT id FROM jobs
               WHERE state = 'queued'
                 AND (next_publish_at IS NULL AND created_at < now() - 30 s OR next_publish_at <= now())
               ORDER BY publish_attempts, id LIMIT 100 FOR UPDATE SKIP LOCKED)
  RETURNING id
  ```

  then **commits**, and **only after the commit** sends each id to the broker.
  No lock is held across the network, two replicas get disjoint batches, a batch
  is bounded (100), and rows published fewer times go first, so a backlog cannot
  starve the rows behind it. Backoff between publications of one row is 15 s,
  30 s, 60 s ... capped at 300 s. A broker that refuses a message stops the batch;
  the rest wait out their backoff. A crash between the commit and the send loses
  at most one backoff interval. On SQLite there is no `SKIP LOCKED`: each row is
  claimed by an `UPDATE` that only matches while it is as it was read.
- **One reconciler per cycle.** On PostgreSQL a cycle starts by taking
  `pg_try_advisory_xact_lock` on a fixed key (`reconciler.RECONCILER_LOCK_KEY`)
  in a dedicated session whose transaction stays open for the whole cycle; a
  replica that does not get it skips the cycle. Losing the lock early (a dropped
  connection) only costs the exclusivity: every step is a conditioned `UPDATE`.
  SQLite takes no lock.
- **Duplicates.** The same job can be published more than once (the immediate
  message, a republication, a Dramatiq retry of up to 5 times for failures before
  the claim). The claim in step 1 makes every extra message a no-op.

### The queue limit

A job that stays `queued` for more than `QUEUE_TIMEOUT_S` (default 1800, at
least 60) without a worker claiming it is failed with `result.code =
"queue_timeout"` and its study cell is synchronised. The wait is counted from
creation, or from the moment a lost worker's job was put back. It is independent
of the job's own budget: a queued job has not started, so its budget (which used
to fail a queued job 120 s after the budget had passed, even with the queue
merely busy) no longer applies to it; the budget still governs running jobs
without a lease.

## Remote Engines (G4)

`bim-engine/v1` has no idempotency key and no cancellation operation, and this
change does not alter the protocol (its digest is pinned). What the gateway does:

- Every request to the Engine carries `X-Openbinding-Job-Id` (the gateway job id)
  and `X-Openbinding-Attempt` (the claim number). They are **documented hints**: an
  Engine may use them to recognise a repeated submission, or ignore them. An
  Engine that ignores them will run the work again.
- As soon as the Engine accepts a job (`202` + receipt) and *before* waiting for
  the result, the gateway stores the Engine's id in `jobs.engine_job_id` and
  commits. (Until then that column holds the gateway job id.) If the commit fails
  the attempt goes on and the id is simply not recorded; an id longer than the
  column (128) is not recorded either.
- When the gateway discards a late result (lease lost), notices a cancellation, or
  gives up on an accepted job (error, timeout), it sends a best-effort
  `DELETE` on the Engine's job resource (the registration's `job` mapping), with a
  3 s timeout and without propagating any error. Engines may answer 404/405; that
  is not an error. The cancel call is made outside any transaction.

## Engine answers kept for re-evaluation (B4)

An Engine's answer is accepted as a result only after BIM recomputes it from the
IR. The solve can take up to half an hour and BIM can be unavailable for a
minute, so the raw answer is no longer lost when BIM fails.

- **Order.** In `services/execution.py` (`settle_engine_answer`) the worker takes
  the lease (`hold_lease`, which locks the row) and checks the cancellation; it
  then **writes the raw answer to `job_engine_evidence` and commits** (which
  releases the row lock) *before* calling BIM. BIM runs with no transaction open.
  Afterwards the worker takes the lease again and **checks `cancellation_requested`
  again**: a cancellation can arrive while BIM works, and then the job ends
  `CANCELLED` and its evidence is deleted. If the lease was lost after the commit,
  the worker deletes its own row (best effort) and writes nothing else.
- **The table.** `job_engine_evidence`: `id`, `job_id` (`ON DELETE CASCADE`),
  `attempt` (the `jobs.attempt` of the claim that received the answer),
  `raw_result` (JSON, at most 4 MiB, the bound of `v1.remote.MAX_REMOTE_RESPONSE`;
  an answer over it is not kept), `digest`, `created_at`, `expires_at`; unique on
  `(job_id, attempt)`. Migration `a5b6c7d8e9f0`, hanging from `f2a3b4c5d6e7`. Its
  downgrade drops the table, so the answers still kept are destroyed and those
  jobs can only be retried (which runs the Engine again).
- **BIM fails.** The job is `FAILED`, `termination = UNKNOWN`, `solutions = []`,
  with `result.code = "bim_evaluation_failed"`, the fixed sentence of the catalog,
  `correlationId` and `result.evidence = {id, digest, expiresAt}`: a reference,
  never the body. Something that was not evaluated is never recorded as valid or
  completed. The exception goes to the log with the same id.
- **Success.** Any success deletes **every** evidence row of the job, in the
  transaction that writes `COMPLETED`.
- **No `GET /evidence`.** The body of an Engine published by another owner can carry
  that owner's text, so no route returns it. It is only read to be evaluated again.
- **Retention.** `EVIDENCE_RETENTION_DAYS` (default 14, from 1 to 90). The
  reconciler's cycle deletes expired rows in a bounded batch (500 per cycle,
  `FOR UPDATE SKIP LOCKED`), comparing with the database clock like the leases.
- **Re-evaluating: `POST /v1/jobs/{id}/reevaluate`.** Only the owner of the job,
  with MEMBER in its organization when it has one (`require_work_role`); an API key
  needs `engines:execute`, so a read-only key is refused, and a key inherits the
  role of its user (a VIEWER's key is refused). A job that is not the caller's is
  `404`. It does not run the Engine again; it uses only the row whose `attempt`
  equals `jobs.attempt`. Refusals, all `409` unless said: `job_in_study` (the job
  has a `study_cell_id`: `study_jobs.py` protects only `FAILED`, and a cell of a
  cancelled run must not become `COMPLETED`), `job_already_retried` (a `retry`
  exists), `cancellation_requested`, `job_not_reevaluable` (not `FAILED` with code
  `bim_evaluation_failed`, or it lost the race below), and `410 evidence_expired`
  (no evidence row, an expired one, or a row that is not the one the job refers to).
  If BIM fails again the answer is `503 bim_evaluation_failed` and nothing changes:
  the job stays `FAILED` with the same evidence, and no row is added.
- **The transition is a compare-and-set.** BIM is called with no lock; the job row
  is then locked, every refusal above is checked again, and one `UPDATE ... SET
  state = 'completed' ... WHERE state = 'failed' AND NOT cancellation_requested AND
  study_cell_id IS NULL AND result->>'code' = 'bim_evaluation_failed' AND EXISTS
  (the evidence row of that id and of the job's current attempt)` decides. Of two
  simultaneous calls one wins and the other gets `409`; a cancellation that came in
  meanwhile wins. The winner deletes the job's evidence and writes a `job.reevaluated`
  audit event in the same transaction.

The row of *Failure modes* below that says the engine's result is lost when BIM
fails (B4) describes the behaviour before this section.

## Failure modes

| Failure | Result |
|---|---|
| Duplicate queue message | Second claim finds the job not `queued` and does nothing |
| Redis down after commit | `202` is still returned; the job stays `queued` and the publisher sends it, with backoff, when Redis returns |
| Message lost after commit | Same: the publisher covers it after 30 s |
| Queue backed up | Republished messages accumulate, at most one per backoff step per job (15 s ... 300 s); duplicates are harmless. After `QUEUE_TIMEOUT_S` the job fails with `queue_timeout` |
| Worker dies mid-solve | Lease lapses; the job runs again once, then fails. **The Engine may have run the first attempt to completion or partly** (the gateway then asks it to cancel, best effort) |
| Worker is slow, not dead, and loses its lease (long pause, missed beats) | The job is requeued and runs a second time; for a while **two solves run in parallel**. The first worker's late answer is discarded by `hold_lease` and the remote job is cancelled best effort. The Engine did the work twice |
| Gateway crashes after the Engine accepted a job and before the id was committed | The id is not recorded and the remote job is orphaned. Only the idempotency hints can mitigate it |
| Gateway restarts between the Engine's answer and the database commit | The result is lost for that attempt; the job is requeued or failed by the reconciler |
| Replica with a skewed clock | No effect on PostgreSQL (all comparisons use the database clock); on SQLite there is only one process |
| Database connection holding the reconciler lock drops | Two replicas may run a cycle at once; harmless, every step is conditioned |
| Lease lost (B3) or bim fails during re-evaluation (B4) | B3: the old holder keeps waiting for the engine and `_requeue` does not cancel the remote job; only its late result is discarded. B4: if bim fails when the result is re-evaluated, the job becomes `FAILED` and the engine's result is lost. Both open, see [qa/SECURITY_REVIEW.md](qa/SECURITY_REVIEW.md) |
| Analysis task whose worker keeps dying | Requeued twice, failed as `analysis_abandoned` on the third lost lease |
| Client retries after a timeout with the same key | Replay of the original job |
| Client retries with a new key (or none) | A new job; nothing links it to the first |

Consequently **Engines must tolerate seeing the same job more than once**. A
remote Engine's side effects are at least once and the gateway cannot make them
exactly once. The platform's own reads are protected by re-evaluation: a result
is accepted only after OpenBinding recomputes it from the IR, so a duplicate run
cannot change the recorded decision, but it can cost compute.

## Analysis tasks

`analysis_jobs.py` follows the same scheme: a lease renewed from a background
beat (every 20 s, 60 s lease, by the database clock) and a cap of three claims
(`analysis_tasks.attempts`, same migration). A task whose lease lapses is put back
while `attempts < 3`; at the third lost lease it is failed with
`error = "analysis_abandoned"`. Re-submitting a failed or cancelled task goes
through `routes/analysis.py`, which does not reset `attempts`: such a task gets a
single claim before it is failed as abandoned if its worker is lost again.

## What has been certified

**Executed earlier on a real PostgreSQL (in the lab; reported by the QA owner):** the claim has one winner; concurrent sweeps fail an
abandoned job once; `SKIP LOCKED` lets a sweep pass a locked row and take it
later; the per-account concurrency limit; idempotency with one job under
concurrent creation; study-cell launch races. These are the `test_*_pg.py` files
that existed before this change (`test_job_leases_pg.py` first four tests,
`test_jobs_idempotency_pg.py`, `test_study_cells_pg.py`).

**Executed on PostgreSQL 16 in the lab (`lab_compose` with
`compose.pgtest.json`): `tests/concurrency` gave 58 passed, 0 skipped in 12 s.**
The 26 compose-shape tests now live in the normal suite
(`tests/test_pg_harness.py`) and are no longer skipped; the studies fixture
creates the owner's membership; each test has a 60 s watchdog. An earlier run
(SHA `5aebc7c8`) gave 45 passed, 26 skipped. See [qa/PG_HARNESS.md](qa/PG_HARNESS.md).
The tests listed below were written in an earlier change; they skip without
`TEST_DATABASE_URL`. This page does not break the 58 down per file, so treat the
list as scope, not as a per-test result:

- `tests/concurrency/test_job_leases_pg.py`: leases written by the database clock
  with the process clock +10 min; a process clock +10 min does not requeue a live
  lease and −10 min does not keep a lapsed one alive; `hold_lease` locks and
  renews; a holder whose job was taken back is refused.
- `tests/concurrency/test_job_publication_pg.py`: disjoint batches under `SKIP
  LOCKED`, a locked row skipped, backoff and its cap computed by the database
  (including `publish_attempts = 1000`), queue-limit failure, a skewed process
  clock fails and publishes nothing, the second reconciler skips the cycle while
  the first holds the advisory lock.
- The SQL itself (`make_interval`, `power`, `LEAST`, the `IN (... FOR UPDATE SKIP
  LOCKED)` subquery, a `BIGINT` advisory key) is exercised by those tests on
  PostgreSQL; the SQLite suite only compiles and string-compares it.
- The migration `f2a3b4c5d6e7`: the PG run applies `alembic upgrade head`; it was
  not tested separately.

**Covered by SQLite only:** the controlled-clock lease tests, the publisher's
claim / backoff / commit-before-send ordering, the queue limit, analysis-task
attempts and heartbeat, remote ids / hints / cancellation against a simulated
transport (`httpx.MockTransport`). SQLite has no row locks or `SKIP LOCKED`; the
claim race there is decided by the single `UPDATE`.

**Not exercised anywhere:** a real Redis / Dramatiq broker failing mid-batch,
real remote Engines under crash injection, the cancel call against an Engine that
implements it.

Related: [ACCOUNTS_AND_PLANS.md](ACCOUNTS_AND_PLANS.md) (the concurrency cap),
[ARCHITECTURE.md](ARCHITECTURE.md) (where `jobs/` sits), and
[qa/JOINT_STATUS.md](qa/JOINT_STATUS.md).
