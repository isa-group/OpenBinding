# qacobench-experimentation Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/baseline` @ 9b5be00 for the files cited as evidence; the reference behaviour is the owner's QACOBench
1.1.1 release (014e43a, origin/feat-isa), whose additions are marked "feat-isa" and are not yet in the baseline tree.

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

Evidence: `experimentation/qacobench/campaign.py`; `experimentation/qacobench/test_qacobench.py::test_gateway_result_and_resume_key_follow_public_contract`

#### Scenario: Interrupted campaign
- **GIVEN** a `results.jsonl` with 10,000 recorded executions
- **WHEN** the campaign is started again without `--fresh`
- **THEN** those 10,000 executions are not resubmitted

### Requirement: Stale engine registrations refused
IF the digest of a registered engine manifest differs from the checkout's `schemas/bim/v1/manifests/<engine>.json`, THEN THE campaign runner SHALL refuse to run.

`req~qacobench-experimentation-stale-registration~1`

Evidence: GAP on the baseline tree (`experimentation/qacobench/campaign.py` has no manifest-digest check); implemented on feat-isa in origin/feat-isa:experimentation/qacobench/campaign.py

#### Scenario: Engine manifest changed after the last build
- **GIVEN** the minizinc manifest was edited and the Compose volumes still hold the old registration
- **WHEN** `run.sh campaign` starts
- **THEN** the runner stops and asks for `run.sh reset`

### Requirement: Run manifest
WHEN a campaign is prepared, THE harness SHALL record a run manifest with image identities, a source-tree digest, engine manifest digests, seeds, budgets, configuration hashes and host information, and (feat-isa) the MiniZinc version and solver list.

`req~qacobench-experimentation-run-manifest~1`

Evidence: `experimentation/qacobench/capture_run_manifest.py`; `experimentation/qacobench/test_qacobench.py::test_release_registry_and_seed_are_stable`

#### Scenario: Two hosts
- **GIVEN** the same tag run on two hosts
- **WHEN** both capture their manifests
- **THEN** the source-tree digest and engine manifest digests are equal and the host sections differ

### Requirement: Capability rejections are data
WHEN an engine refuses an instance with 422 for capability reasons, THE campaign runner SHALL record the execution as `INCOMPATIBLE` with the engine diagnostics; IF a quota, communication or unclassified infrastructure error occurs, THEN THE campaign runner SHALL stop.

`req~qacobench-experimentation-incompatible-is-data~1`

Evidence: `experimentation/qacobench/campaign.py`; GAP: the classification test `test_rejections_keep_the_engine_detail_and_reasons_are_classified` exists only on feat-isa

#### Scenario: MiniZinc refuses a soft constraint
- **GIVEN** an instance with a soft constraint expression
- **WHEN** it is submitted to `minizinc-csp`
- **THEN** the record is `INCOMPATIBLE` with the 422 diagnostics and the campaign continues

### Requirement: Contradicted verdicts refuse the campaign
IF an engine's `INFEASIBLE` proof is contradicted by a validated binding of another engine, or an `OPTIMAL` score is strictly beaten by another engine, THEN THE evaluation SHALL refuse to accept the campaign.

`req~qacobench-experimentation-contradiction-refusal~1`

Evidence: GAP on the baseline tree (`experimentation/qacobench/evaluate_results.py` has no reconciliation); on feat-isa test_evaluation_reconciles_exact_labels_against_validated_bindings in experimentation/qacobench/test_qacobench.py and reference/1.1.1/evaluation/acceptance.json

#### Scenario: UNSAT contradicted
- **GIVEN** MiniZinc reports `INFEASIBLE` for an instance and random-search returns a binding the gateway validated as feasible
- **WHEN** `run.sh evaluate` runs
- **THEN** the evaluation fails and reports the contradiction

### Requirement: Data outside Git
THE harness SHALL keep generated suites, raw results (`.artifacts/qacobench/`) and archive bundles out of Git, distributing them through the Zenodo software and dataset deposits verified by SHA-256 checksums.

`req~qacobench-experimentation-data-outside-git~1`

Evidence: `.gitignore`; `docs/adr/0008-datasets-outside-git.md`; on feat-isa tools/package_zenodo.sh and experimentation/qacobench/verify_dataset_digests.py

#### Scenario: Accidental force-add
- **GIVEN** a contributor runs `git add -f datasets/07_qfbs`
- **WHEN** the PR is checked
- **THEN** the file-ownership gate (G10) blocks it

### Requirement: Reproducible QFBS generation
WHEN QFBS instances are generated, THE harness SHALL use `design_matrix.json` as the single source of truth, one HTTP generation request per instance with recorded configuration, seed and response digests, and SHALL refuse to resume from a manifest of another design.

`req~qacobench-experimentation-qfbs-generation~1`

Evidence: `experimentation/qacobench/generate_qfbs.py`; `experimentation/qacobench/design_matrix.json`; `experimentation/qacobench/test_qacobench.py::test_qfbs_design_and_requests_match_the_two_groups`

#### Scenario: Design changed between runs
- **GIVEN** a generation manifest written for design v2
- **WHEN** generation resumes with a modified `design_matrix.json`
- **THEN** the generator refuses to resume

### Requirement: Historical ICSOC optimum reproduced
WHEN the ICSOC regression runs against the stack, THE platform SHALL regenerate `mediaOrch/146588263/infrastructure_50`, reproduce the historical MiniZinc optimum and classify the seeded heuristic results.

`req~qacobench-experimentation-icsoc-regression~1`

Evidence: `openbinding-gateway/tests/integration/test_icsoc_regression.py`; `README.md`

#### Scenario: Engine change alters the optimum
- **GIVEN** a change to the MiniZinc model
- **WHEN** the integration suite runs
- **THEN** the ICSOC regression fails if the historical optimum is not reproduced

## Out of scope

- The engines and the generator themselves (`engine-minizinc`, `engines-java`, `generator`).
- Paper writing; LaTeX macros are an output, not a contract.

## TODO

- Re-baseline this spec when 014e43a is integrated (secondary analyses, reference 1.1.1, `--repeats`, `--concurrency`).
- Tolerance for reproducing aggregate tables (INTENT O3) — owner to define.
- `experimentation/icsoc/original_dataset/` must move to the `data/icsoc-original-dataset` branch (ADR-0008).
- `watch_nipogi.sh` is removed in 014e43a; confirm.
