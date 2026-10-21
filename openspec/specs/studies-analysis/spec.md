# studies-analysis Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/baseline` @ 9b5be00 — reverse-engineered, spec-anchored.

## Purpose

Reproducible comparative studies (a matrix of case revisions × engine modes × options run as jobs, with cells, runs,
analytics) and binding analysis (neighbourhood of a binding, Pareto analysis tasks, decision workspace).
Code: `studies.py`, `study_jobs.py`, `routes/studies.py`, `analysis_jobs.py`, `routes/analysis.py`; docs:
`docs/analysis/binding-decision-workspace.md`.

## Requirements

### Requirement: Deterministic, bounded study matrix
WHEN a study run is created, THE gateway SHALL expand the study definition into a sorted, fingerprinted cartesian matrix, refuse it before creating any job if it exceeds the matrix bound, and persist exactly that matrix with the run.

`req~studies-analysis-deterministic-matrix~1`

Evidence: `openbinding-gateway/tests/test_studies_platform.py::test_matrix_expansion_is_sorted_reproducible_and_fingerprinted`; `openbinding-gateway/tests/test_studies_platform.py::test_study_matrix_is_bounded_before_any_jobs_are_created`; `openbinding-gateway/tests/test_studies_platform.py::test_study_run_persists_the_exact_cartesian_matrix`

#### Scenario: Same definition twice
- **GIVEN** a study definition with 2 case revisions and 3 engine modes
- **WHEN** two runs are created from the same version
- **THEN** both persist the same 6 cells in the same order with the same fingerprint

### Requirement: Explicit engine choice per study
IF a study definition omits the mode or the optimization of an engine, or repeats an axis, or names a malformed engine digest, THEN THE gateway SHALL refuse the definition.

`req~studies-analysis-explicit-engine~1`

Evidence: `openbinding-gateway/tests/test_studies_platform.py::test_study_definition_requires_an_explicit_mode_and_optimization_per_engine`; `openbinding-gateway/tests/test_studies_platform.py::test_study_definition_rejects_duplicate_axes_and_malformed_engine_digests`

#### Scenario: Engine without a mode
- **GIVEN** a definition that lists `random-search` without `mode`
- **WHEN** it is sealed
- **THEN** the gateway refuses it; no default mode is chosen for the user

### Requirement: One job per cell
WHEN a study cell is launched or retried more than once, THE gateway SHALL return the job of the first launch or retry instead of creating another.

`req~studies-analysis-one-job-per-cell~1`

Evidence: `openbinding-gateway/tests/test_study_cell_launch.py::test_launching_the_same_cell_again_returns_the_same_job`; `openbinding-gateway/tests/test_study_run_concurrency.py::test_a_second_retry_of_a_cell_is_answered_with_the_first_ones_job`; `openbinding-gateway/tests/concurrency/test_study_cells_pg.py`

#### Scenario: Double click on retry
- **GIVEN** a failed cell
- **WHEN** two retry requests arrive at the same time
- **THEN** both answers name the same new job

### Requirement: Cancelling a run
WHEN a run is cancelled, THE gateway SHALL lock the run, then its cells, then their jobs, launch no further cell, and keep cancelled cells cancelled when their jobs are later synced.

`req~studies-analysis-run-cancellation~1`

Evidence: `openbinding-gateway/tests/test_study_run_concurrency.py::test_cancelling_a_run_locks_the_run_then_its_cells_then_their_jobs`; `openbinding-gateway/tests/test_study_run_concurrency.py::test_a_cancelled_run_launches_no_cell_when_a_job_finishes`; `openbinding-gateway/tests/concurrency/test_study_cancel_pg.py`

#### Scenario: Job finishes after cancellation
- **GIVEN** a cancelled run with one job still running
- **WHEN** that job finishes
- **THEN** no new cell is launched and the run stays cancelled

### Requirement: Honest neighbourhood analysis
WHEN the neighbourhood of a binding is analysed, THE gateway SHALL evaluate each one-task substitution with the canonical evaluator within the time budget and SHALL NOT claim local optimality for partial or empty coverage.

`req~studies-analysis-neighbourhood~1`

Evidence: `openbinding-gateway/tests/test_binding_analysis.py::test_partial_and_empty_coverage_never_claims_unchecked_local_optimality`; `openbinding-gateway/tests/test_binding_analysis.py::test_endpoint_requires_owner_and_validates_budget`

#### Scenario: Budget runs out
- **GIVEN** a binding with 10,000 one-task alternatives and a 2 s budget
- **WHEN** only 3,000 are evaluated
- **THEN** the answer reports partial coverage and no local-optimality claim

### Requirement: Analysis work permissions and attempts
WHEN an API key starts or cancels Pareto analysis work, THE gateway SHALL require `engines:execute` in addition to `jobs:read`; a task whose worker is lost SHALL be requeued until its third claim and then failed as `analysis_abandoned`.

`req~studies-analysis-task-permissions-attempts~1`

Evidence: `openbinding-gateway/tests/test_apikey_analysis_scopes.py::test_a_jobs_read_key_cannot_create_analysis_work`; `openbinding-gateway/tests/test_analysis_task_attempts.py::test_the_third_lost_worker_fails_the_task_as_abandoned`

#### Scenario: Read-only key starts a Pareto task
- **GIVEN** a key with only `jobs:read`
- **WHEN** it calls `POST /v1/analysis/pareto`
- **THEN** the gateway answers 403 `insufficient_api_key_permission` listing `engines:execute`, and no task is created

## Out of scope

- The job lifecycle each cell uses (`job-execution`).
- Report editions and publications (`collaboration-artifacts`).

## TODO

- Pareto and stability aggregates (`test_pareto_and_stability_aggregates_are_deterministic`), run analytics endpoint.
- Decision workspace evidence contract (`docs/analysis/binding-decision-workspace.md`) and archive analysis.
- Study versions shared across projects and run pinning of the definition version.
