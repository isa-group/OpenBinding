# job-execution Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

Submission, durable execution, re-evaluation, retry and cancellation of solve jobs (`POST /v1/jobs`,
`GET /v1/jobs[/{id}]`, `POST /v1/jobs/{id}/cancel|retry|reevaluate`), with the guarantees G1–G4 of
`docs/IDEMPOTENCY.md`. Distributed exactly-once execution is explicitly not provided.

## Requirements

### Requirement: Asynchronous acceptance
WHEN an authenticated caller submits a valid job, THE gateway SHALL persist it as `queued` before dispatch and answer 202 with the job id and status.

`req~job-execution-accepted-202~1`

Evidence: `openbinding-gateway/tests/test_job_submission_service.py::test_a_valid_request_creates_a_queued_job`; `docs/openapi.json`; `openbinding-gateway/src/openbinding_gateway/services/job_submission.py`

#### Scenario: Submit a snapshot to the random-search engine
- **GIVEN** a compiled snapshot owned by the caller and an installed `random-search` mode
- **WHEN** the caller posts the job
- **THEN** the answer is 202 with `status` `queued`
- **AND** the job row exists even if Redis is unavailable at that moment

### Requirement: Idempotency key per account
WHEN a request carries an `Idempotency-Key` already used by the same account, THE gateway SHALL replay the original job (202, `idempotent: true`, nothing dispatched) if the canonical request fingerprint matches, and SHALL answer 409 `idempotency_conflict` otherwise; keys of different accounts SHALL be independent.

`req~job-execution-idempotency-key~1`

Evidence: `openbinding-gateway/tests/test_idempotency_jobs.py`

#### Scenario: Client retry after a timeout
- **GIVEN** a job created with key `k1`
- **WHEN** the same account resends the identical request with `k1`
- **THEN** the gateway answers 202 with the original job id and `idempotent: true`

#### Scenario: Same key, different body
- **GIVEN** a job created with key `k1`
- **WHEN** the same account sends a different body with `k1`
- **THEN** the gateway answers 409 with code `idempotency_conflict`

### Requirement: Technical concurrency cap
IF an account already has `MAX_CONCURRENT_JOBS_PER_USER` jobs queued or running (default 8, independent of the plan), THEN THE gateway SHALL refuse a new job with 429 `concurrency_limit_exceeded`, while an idempotent replay at the limit SHALL still return the existing job.

`req~job-execution-concurrency-cap~1`

Evidence: `openbinding-gateway/tests/test_concurrency_limit.py`

#### Scenario: Ninth job
- **GIVEN** an account with 8 running jobs and the default cap
- **WHEN** it submits a ninth job
- **THEN** the gateway answers 429 `concurrency_limit_exceeded` and creates nothing

### Requirement: Single current execution
WHEN several workers try to claim the same queued job, THE gateway SHALL let exactly one claim it under a lease, and SHALL discard any outcome written by a worker that no longer holds the lease token.

`req~job-execution-single-claim~1`

Evidence: `openbinding-gateway/tests/test_job_leases.py`; `openbinding-gateway/tests/concurrency/test_job_leases_pg.py`

#### Scenario: Duplicate queue message
- **GIVEN** a queued job delivered twice by the broker
- **WHEN** two workers claim it
- **THEN** one runs it and the other returns without doing anything

### Requirement: Recovery of lost workers
WHEN a running job's lease lapses, THE gateway SHALL put it back to `queued` once and SHALL mark it `failed` on the second lapse; a job queued longer than `QUEUE_TIMEOUT_S` SHALL fail with `queue_timeout`.

`req~job-execution-lease-recovery~1`

Evidence: `openbinding-gateway/tests/test_job_leases.py`; `openbinding-gateway/tests/test_job_reconciler.py`

#### Scenario: Worker killed mid-solve twice
- **GIVEN** a running job whose worker dies and whose requeued attempt's worker also dies
- **WHEN** the reconciler runs after each lapse
- **THEN** the job is requeued after the first lapse and failed after the second

### Requirement: Authoritative re-evaluation
WHEN an engine returns a result, THE gateway SHALL keep only the binding of each solution, recompute features, objectives and violations with the canonical BIM evaluator, and downgrade any termination claim the engine mode does not declare as a guarantee.

`req~job-execution-authoritative-reevaluation~1`

Evidence: `openbinding-gateway/tests/test_v1_platform_contracts.py`; `openbinding-gateway/tests/test_v1_job_guarantees.py`

#### Scenario: Heuristic claims optimality
- **GIVEN** a `random-search` mode that guarantees only `FEASIBLE`/`UNKNOWN`
- **WHEN** the engine answers `OPTIMAL` with a feasible binding and wrong objective values
- **THEN** the stored result has termination `FEASIBLE` and the objective values computed by the gateway

### Requirement: Engine evidence kept on evaluation failure
IF BIM re-evaluation of an engine answer fails, THEN THE gateway SHALL mark the job `failed` with `bim_evaluation_failed`, keep the raw engine answer as private evidence, and allow a re-evaluation retry without running the engine again.

`req~job-execution-evidence-retention~1`

Evidence: `openbinding-gateway/tests/test_job_evidence.py`

#### Scenario: BIM service unavailable during evaluation
- **GIVEN** an engine answer received while the BIM service is failing
- **WHEN** the worker evaluates it
- **THEN** the job fails with `bim_evaluation_failed` and a later `reevaluate` completes it from the kept answer

### Requirement: Cancellation
WHEN the owner cancels a job, THE gateway SHALL move a queued job to `cancelled` without running it, SHALL ask the engine to stop a running job only if the engine registration declares the cancellation capability, and SHALL never let a late result reopen a cancelled job.

`req~job-execution-cancellation~1`

Evidence: `openbinding-gateway/tests/test_cancel_running_job.py`; `openbinding-gateway/tests/test_concurrency_limit.py`; `docs/qa/ENGINE_CANCELLATION_E2E.md`

#### Scenario: Cancel a running MiniZinc job
- **GIVEN** a running job on `minizinc-csp`, which declares cancellation
- **WHEN** the owner calls `POST /v1/jobs/{id}/cancel`
- **THEN** the gateway sends one `DELETE` to the engine and the job becomes `cancelled` after the engine confirms

### Requirement: Failed jobs show catalog sentences only
WHEN a job fails, THE gateway SHALL store and show only a stable failure code from the job-failure catalog (e.g. `engine_rejected`, `lease_lost`) with its fixed sentence, and SHALL keep the engine's own text, hosts and addresses out of every table and response, logging them with the job id instead.

`req~job-execution-failure-catalog~1`

Evidence: `openbinding-gateway/tests/test_job_error_text.py`; `openbinding-gateway/src/openbinding_gateway/core/public_errors.py`

#### Scenario: Engine refuses the IR with 422
- **GIVEN** a running job whose engine answers 422 with a detailed rejection
- **WHEN** the worker records the failure
- **THEN** the job shows code `engine_rejected` and "The engine rejected the request." and the engine's detail appears only in the log

### Requirement: Only owners and members act on jobs
IF a caller who is not the job's owner, or whose organization role is below MEMBER, tries to launch, retry or cancel a job, THEN THE gateway SHALL refuse before compiling, reserving or writing anything (403 `insufficient_role`, or 404 when the caller has no role at all).

`req~job-execution-actor-authorization~1`

Evidence: `openbinding-gateway/tests/test_viewer_read_only.py`; `openbinding-gateway/tests/test_cancel_running_job.py`

#### Scenario: Viewer launches a job
- **GIVEN** a VIEWER of the organization that owns a shared snapshot
- **WHEN** the viewer posts a job on that snapshot
- **THEN** the gateway answers 403 `insufficient_role` and no job or idempotency key is stored

## Out of scope

- The engine side of the protocol (`engine-protocol`) and engine registration (`engine-registry`).
- Study cells and analysis tasks, which reuse this lifecycle (`studies-analysis`).

## TODO

- Result vocabulary (`OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`) and job states (`queued`, `running`, `completed`, `failed`, `cancelled`) as an explicit state-machine requirement.
- VIEWER redaction of failed-job errors (`docs/ACCOUNTS_AND_PLANS.md`).
- Distinguishing a capability rejection (engine 422) from other refusals for API clients such as QACOBench (OPEN QUESTION: `engine_incompatible` code).
- Publisher backoff and queue limit details; remote attempt ids and idempotency hints (G4).
- Job events stream (`GET /v1/jobs/{id}/events`) and neighbourhood analysis endpoint.
- Not exercised anywhere (per `docs/IDEMPOTENCY.md`): real Redis failing mid-batch, remote engines under crash injection; Java engines in async mode behind the gateway end to end.
