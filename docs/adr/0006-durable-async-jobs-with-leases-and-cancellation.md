Status: DRAFT for owner review (2026-10-21)

# ADR-0006: Durable asynchronous jobs with an outbox, leases, idempotency keys and best-effort cancellation

- Status: Accepted
- Date: 2026-10-21 (recorded)
- Deciders: owner (approved joint plan)

## Context and problem

Solves run for seconds to minutes; workers and engines can crash; clients retry. The platform must never lose an
accepted job, never run two current executions, and say honestly what it cannot guarantee.

## Decision

`POST /v1/jobs` always answers `202`. The `queued` row in PostgreSQL is the outbox; Dramatiq over Redis delivers work
at least once; a single conditional `UPDATE` claims a job under a 60 s lease renewed every 20 s; a reconciler requeues a
lapsed job once and then fails it; `Idempotency-Key` gives at most one job per (account, key) bound to a request
fingerprint; a technical per-account concurrency cap answers `429`. Cancellation of a running job is sent to the engine
only when its registration declares the capability, and a late result never reopens a cancelled job.

## Consequences

- Guarantees G1–G4 of `docs/IDEMPOTENCY.md`; end-to-end exactly-once is explicitly not claimed.
- Locking logic must be tested on real PostgreSQL (`tests/concurrency/*_pg.py`), not only SQLite.
- Engines with async mode (MiniZinc, Java with `ENGINE_JOB_MODE=async`) implement job polling and optional `DELETE`.

## Evidence

`docs/IDEMPOTENCY.md`, `openbinding-gateway/src/openbinding_gateway/jobs/`, `openbinding-gateway/tests/test_idempotency_jobs.py`,
`openbinding-gateway/tests/test_job_leases.py`, `openbinding-gateway/tests/test_cancel_running_job.py`, `docs/qa/PG_REAL_RUN.md`.
