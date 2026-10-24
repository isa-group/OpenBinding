# qacobench-experimentation Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c, which contains the owner's QACOBench 1.1.1
release 014e43a) — reverse-engineered, spec-anchored.

## Purpose

QACOBench (`experimentation/qacobench/`): a reproducible benchmark campaign over the public OpenBinding API —
10,250 instances recovered from six research sources plus 5,200 QFBS instances generated through
`POST /v1/generator/instances`, submitted to three engines (46,350 executions at a 5,000 ms budget in 1.1.1) —
with run manifests, evaluation, figures and Zenodo packaging. Historical experiments (`experimentation/icsoc`,
`experimentation/icws`) are out of scope except for the ICSOC regression.

## Requirements

### Requirement: Resumable campaign by identity
WHEN a campaign is restarted without `--fresh`, THE campaign runner SHALL skip every execution already recorded for the same suite, instance, engine, budget, seed and package digest, and SHALL submit each execution with an idempotency key derived from that identity.

`req~qacobench-experimentation-resume-identity~1`

Evidence: `experimentation/qacobench/campaign.py`; `experimentation/qacobench/test_qacobench.py`

#### Scenario: Interrupted campaign
- **GIVEN** a `results.jsonl` with 10,000 recorded executions
- **WHEN** the campaign is started again without `--fresh`
- **THEN** those 10,000 executions are not resubmitted

### Requirement: Stale engine registrations refused
IF the digest of a registered engine manifest differs from the checkout's `schemas/bim/v1/manifests/<engine>.json`, THEN THE campaign runner SHALL refuse to run.

`req~qacobench-experimentation-stale-registration~1`

Evidence: `experimentation/qacobench/campaign.py`; `experimentation/qacobench/README.md`

#### Scenario: Engine manifest changed after the last build
- **GIVEN** the minizinc manifest was edited and the Compose volumes still hold the old registration
- **WHEN** `run.sh campaign` starts
- **THEN** the runner stops and asks for `run.sh reset`

### Requirement: Run manifest
WHEN a campaign is prepared, THE harness SHALL record a run manifest with image identities, a source-tree digest (including the bim-core sources), engine manifest digests, seeds, budgets, configuration hashes, host information, and the MiniZinc version and solver list.

`req~qacobench-experimentation-run-manifest~1`

Evidence: `experimentation/qacobench/capture_run_manifest.py`; `experimentation/qacobench/reference/1.1.1/run_manifest.json`

#### Scenario: Two hosts
- **GIVEN** the same tag run on two hosts
- **WHEN** both capture their manifests
- **THEN** the source-tree digest and engine manifest digests are equal and the host sections differ

### Requirement: Capability rejections are data
WHEN an engine refuses an instance with 422 for capability reasons, THE campaign runner SHALL record the execution as `INCOMPATIBLE` with the engine diagnostics; IF a quota, communication or unclassified infrastructure error occurs, THEN THE campaign runner SHALL stop.

`req~qacobench-experimentation-incompatible-is-data~1`

Evidence: `experimentation/qacobench/test_qacobench.py`; GAP: job-level rejections are no longer recognisable (see TODO)

#### Scenario: MiniZinc refuses a soft constraint
- **GIVEN** an instance with a soft constraint expression
- **WHEN** it is submitted to `minizinc-csp`
- **THEN** the record is `INCOMPATIBLE` with the 422 diagnostics and the campaign continues

### Requirement: Contradicted verdicts refuse the campaign
IF an engine's `INFEASIBLE` proof is contradicted by a validated binding of another engine, or an `OPTIMAL` score is strictly beaten by another engine, THEN THE evaluation SHALL refuse to accept the campaign.

`req~qacobench-experimentation-contradiction-refusal~1`

Evidence: `experimentation/qacobench/evaluate_results.py`; `experimentation/qacobench/test_qacobench.py`

#### Scenario: UNSAT contradicted
- **GIVEN** MiniZinc reports `INFEASIBLE` for an instance and random-search returns a binding the gateway validated as feasible
- **WHEN** `run.sh evaluate` runs
- **THEN** the evaluation fails and reports the contradiction

### Requirement: Data outside Git
THE harness SHALL keep generated suites, raw results (`.artifacts/qacobench/`) and archive bundles out of Git, distributing them through the Zenodo software and dataset deposits verified by SHA-256 checksums.

`req~qacobench-experimentation-data-outside-git~1`

Evidence: `.gitignore`; `docs/adr/0008-datasets-outside-git.md`; `tools/package_zenodo.sh`; `experimentation/qacobench/verify_dataset_digests.py`

#### Scenario: Accidental force-add
- **GIVEN** a contributor runs `git add -f datasets/07_qfbs`
- **WHEN** the PR is checked
- **THEN** the file-ownership gate (G10) blocks it

### Requirement: Reproducible QFBS generation
WHEN QFBS instances are generated, THE harness SHALL use `design_matrix.json` as the single source of truth, one HTTP generation request per instance with recorded configuration, seed and response digests, and SHALL refuse to resume from a manifest of another design.

`req~qacobench-experimentation-qfbs-generation~1`

Evidence: `experimentation/qacobench/generate_qfbs.py`; `experimentation/qacobench/test_qacobench.py`

#### Scenario: Design changed between runs
- **GIVEN** a generation manifest written for design v2
- **WHEN** generation resumes with a modified `design_matrix.json`
- **THEN** the generator refuses to resume

### Requirement: Historical ICSOC optimum reproduced
WHEN the ICSOC regression runs against the stack, THE platform SHALL regenerate `mediaOrch/146588263/infrastructure_50`, reproduce the historical MiniZinc optimum and classify the seeded heuristic results.

`req~qacobench-experimentation-icsoc-regression~1`

Evidence: `openbinding-gateway/tests/integration/test_icsoc_regression.py`; GAP: skipped unless the ICSOC dataset is materialized from branch data/icsoc-original-dataset

#### Scenario: Engine change alters the optimum
- **GIVEN** a change to the MiniZinc model
- **WHEN** the integration suite runs
- **THEN** the ICSOC regression fails if the historical optimum is not reproduced

## Out of scope

- The engines and the generator themselves (`engine-minizinc`, `engines-java`, `generator`).
- Paper writing; LaTeX macros are an output, not a contract.

## TODO

- Job-level capability rejections: the runner recognised them by the prefix `engine rejected BindingProblem (422)` of the job
  error, but the gateway now shows only the catalog sentence of `engine_rejected` for failed engine jobs, so they cannot be told
  apart from other engine refusals (OPEN QUESTION: dedicated `engine_incompatible` code, see `job-execution`).
- ICSOC regression: CI materializes the dataset when the branch `data/icsoc-original-dataset` is published; see `README.md` and
  `experimentation/icsoc/README.md`.
- Secondary analyses (`secondary/`), `--repeats`, `--concurrency` and paper macros as requirements.
- Tolerance for reproducing aggregate tables (INTENT O3) — owner to define.
- Provenance digests recorded after the integration differ from `reference/1.1.1` (the run manifest now hashes bim-core
  sources and the minizinc-csp manifest is 1.1.1); decide whether 1.1.1 is re-run on the integrated tree or kept as historical.
- The ICSOC generator (`experimentation/icsoc/generator/`) writes Placement and RoutingOverlay under the `application` role,
  which the installed `qos-binding/v1` Profile does not accept (it declares them in `candidateCatalog`); its validation test fails
  (also on 014e43a).
