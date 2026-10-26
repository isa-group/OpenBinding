## MODIFIED Requirements

### Requirement: CI runs on pushes to develop
THE CI workflow SHALL run every job on a push to `develop` and on a `workflow_dispatch`, and SHALL skip a job only on a `pull_request` run and only through a job-level `if` on an output of job `changes`, with no `paths` filter on any trigger.

`req~ci-develop-push~2`

Evidence (planned, slice S3): lab/tests/test_ci_triggers.py::test_ci_runs_on_push_to_develop, ::test_triggers_leave_permissions_and_pull_request_unchanged and a test that every job-level `if` reads only `needs.changes.outputs.<area>`

#### Scenario: A push to develop
- **GIVEN** `.github/workflows/ci.yml`
- **WHEN** its `on:` block is parsed
- **THEN** it has a `push` trigger with `branches` `[develop]` and no `paths` filter

#### Scenario: Existing triggers and permissions stay
- **GIVEN** `ci.yml` with the new jobs
- **WHEN** it is parsed
- **THEN** the `pull_request` trigger still has `branches` `[main, develop]` and no `paths` or `paths-ignore` filter
- **AND** the top-level `permissions` are exactly `contents: read`
- **AND** the `on:` block has no `schedule` trigger

#### Scenario: Job-level conditions read only the change outputs
- **GIVEN** `ci.yml`
- **WHEN** the `if:` key of every job is collected
- **THEN** each one, except that of `ci-required`, is exactly `needs.changes.outputs.<area> == 'true'` for an area among `e2e`, `bim`, `engines` and `gateway`, and that job lists `changes` in `needs`
- **AND** no job-level `if` names `github.event_name`, `github.ref` or `github.event.pull_request`

#### Scenario: Push and dispatch skip nothing
- **GIVEN** a push run on `develop`, or a `workflow_dispatch` run such as the nightly one
- **WHEN** CI runs
- **THEN** job `changes` sets every area output to `true`
- **AND** no job of the run ends `skipped`

### Requirement: A newer develop push cancels only the older push run
WHEN a newer `pull_request` or `push` run of CI starts in the concurrency group of an in-progress run of the same event, the same pull request or the same pushed ref, THE workflow SHALL cancel the older in-progress run, and SHALL NOT cancel any `workflow_dispatch` run.

`req~ci-develop-push-concurrency~2`

Evidence (planned, slice S7): lab/tests/test_ci_triggers.py::test_push_concurrency_cancels_only_push_runs, renamed for the new rule

#### Scenario: The concurrency block
- **GIVEN** `ci.yml`
- **WHEN** its top-level `concurrency` block is read
- **THEN** `group` is `ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.ref || github.event.pull_request.number || github.run_id }}`
- **AND** `cancel-in-progress` is `${{ github.event_name != 'workflow_dispatch' }}`
- **AND** manual runs get a group of their own by run id, so they are never queued or cancelled

#### Scenario: Two merges land close together
- **GIVEN** a push run on `develop` head A is in progress
- **WHEN** a push of head B to `develop` starts CI
- **THEN** the run on head A is cancelled and head B gets the result

#### Scenario: A new commit on a pull request
- **GIVEN** a `pull_request` run of pull request 61 on head A is in progress
- **WHEN** head B is pushed to the branch of pull request 61
- **THEN** the run on head A is cancelled and head B gets the result
- **AND** an in-progress `pull_request` run of pull request 62 keeps running

#### Scenario: Manual runs are never cancelled
- **GIVEN** a `workflow_dispatch` run on `develop` is in progress
- **WHEN** a second `workflow_dispatch` run or a push run on `develop` starts
- **THEN** the first manual run keeps running

### Requirement: bim-toolchain tests on every pull request
WHEN CI runs and the `bim` area output of job `changes` is `true`, THE `bim-toolchain` job SHALL run, as one job per package `bim-core`, `bim-service` and `bim-client`, the pytest suite of that package with the gateway's locked environment, and SHALL fail on any test failure.

`req~gate-tooling-bim-toolchain-tests~2`

Evidence (planned, slice S6): lab/tests/test_ci_gate_tooling.py::test_bim_toolchain_job_runs_package_tests, revised for one job per package

#### Scenario: The job in the workflow
- **GIVEN** `ci.yml`
- **WHEN** it is parsed
- **THEN** the workflow triggers on `pull_request` with no `paths` filter and job `bim-toolchain` has `if: needs.changes.outputs.bim == 'true'` and a matrix over exactly `bim-core`, `bim-service` and `bim-client`
- **AND** its steps fetch and verify the OMG BPMN XSDs with `xsd_inventory.py --ensure`, restore the gateway's locked environment with `uv sync --locked --project openbinding-gateway --extra test`, and run `../openbinding-gateway/.venv/bin/python -m pytest` over `packages/<package>/tests` of the matrix package with `working-directory` `bim-toolchain`
- **AND** no step has `continue-on-error`
- **AND** the `bim-service` job's pytest command carries exactly two `--deselect` options, for `packages/bim-service/tests/analysis/test_analysis_b8_evidence.py::test_the_throughput_cost_of_a_short_switch_interval` and `packages/bim-service/tests/analysis/test_analysis_b8_probe.py::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]` (timing-dependent), and no job deselects anything else

#### Scenario: Goldens run in one job
- **GIVEN** the three package jobs of `bim-toolchain`
- **WHEN** their steps are resolved per matrix value
- **THEN** exactly one of them runs `tools/baseline_core.py --check`

#### Scenario: A failing bim-service test
- **GIVEN** a pull request that breaks a test of `packages/bim-service/tests`
- **WHEN** the `bim-service` job of `bim-toolchain` runs
- **THEN** that job fails and `ci-required` fails

#### Scenario: A pull request outside the bim area
- **GIVEN** a pull request that changes only `docs/agent-work/ci-speed/intake.md`
- **WHEN** CI runs
- **THEN** the `bim` output of `changes` is `false` and the three `bim-toolchain` jobs are skipped
- **AND** `ci-required` succeeds when every other job succeeds

## ADDED Requirements

### Requirement: Change detection by area
WHEN CI runs, THE `changes` job SHALL expose, from `tools/ci_changes.py`, the outputs `e2e`, `bim`, `engines` and `gateway`, each `true` or `false`, with every output `true` on a `push` or `workflow_dispatch` event, on an unknown changed path, on a change to `.github/workflows/ci.yml` or `tools/ci_*.py`, on a git error, and on a diff that lists no path.

`req~ci-speed-change-detection~1`

Evidence (planned, slice S2 and S3): lab/tests/test_ci_changes.py

#### Scenario: Push and dispatch
- **GIVEN** the event `push` or `workflow_dispatch`
- **WHEN** `tools/ci_changes.py` runs
- **THEN** it prints `e2e=true`, `bim=true`, `engines=true` and `gateway=true`

#### Scenario: Unknown path
- **GIVEN** a `pull_request` whose only changed file is `newdir/file.txt`, a path in no area
- **WHEN** `tools/ci_changes.py` runs
- **THEN** every output is `true`

#### Scenario: The workflow or a CI script changes
- **GIVEN** a `pull_request` that changes `.github/workflows/ci.yml`, or one that changes `tools/ci_required.py`
- **WHEN** `tools/ci_changes.py` runs
- **THEN** every output is `true`

#### Scenario: Git fails
- **GIVEN** a `pull_request` whose base SHA is not in the checkout, so `git diff` exits non-zero
- **WHEN** `tools/ci_changes.py` runs
- **THEN** every output is `true`

#### Scenario: Empty diff
- **GIVEN** a `pull_request` whose base and head are the same commit, so `git diff` succeeds and lists no path
- **WHEN** `tools/ci_changes.py` runs
- **THEN** every output is `true`

#### Scenario: Changelog-only pull request
- **GIVEN** a `pull_request` whose only changed file is `frontend/src/content/changelog.generated.json`
- **WHEN** `tools/ci_changes.py` runs
- **THEN** `e2e` is `false`

#### Scenario: Outputs reach the workflow
- **GIVEN** job `changes` in `ci.yml`
- **WHEN** it is read
- **THEN** it checks out with `fetch-depth: 0`, runs `tools/ci_changes.py`, and declares the job outputs `e2e`, `bim`, `engines` and `gateway` from that step

### Requirement: One required aggregate check
WHEN every other job of a CI run has finished, THE `ci-required` job SHALL fail IF any needed job ended `failure` or `cancelled`, job `changes` did not succeed, or a job ended `skipped` while the area output that gates it was not `false`, or while no area output gates it.

`req~ci-speed-required-aggregate~1`

Evidence (planned, slice S2 and S3): lab/tests/test_ci_changes.py (aggregator cases) and lab/tests/test_ci_triggers.py

#### Scenario: The job in the workflow
- **GIVEN** `ci.yml`
- **WHEN** job `ci-required` is read
- **THEN** its `needs` lists every other job of the workflow, its `if` is `always()`, and a step runs `tools/ci_required.py` with `NEEDS: ${{ toJSON(needs) }}` in `env`

#### Scenario: All green with skips
- **GIVEN** `NEEDS` where `changes` succeeded with `e2e=false` and `frontend-e2e` is `skipped`, and every other job is `success`
- **WHEN** `tools/ci_required.py` runs
- **THEN** it exits 0

#### Scenario: A failed or cancelled job
- **GIVEN** `NEEDS` where `engines` is `failure`, or where `test` is `cancelled`
- **WHEN** `tools/ci_required.py` runs
- **THEN** it exits non-zero and names that job

#### Scenario: Failed change detection
- **GIVEN** `NEEDS` where `changes` is `failure` and the area-gated jobs are `skipped`
- **WHEN** `tools/ci_required.py` runs
- **THEN** it exits non-zero

#### Scenario: Skipped although its area changed
- **GIVEN** `NEEDS` where `changes` succeeded with `gateway=true` and `gateway-unit` is `skipped`
- **WHEN** `tools/ci_required.py` runs
- **THEN** it exits non-zero and names `gateway-unit`

#### Scenario: An always-on job is skipped
- **GIVEN** `NEEDS` where every area output is `false` and `lab`, a job that no area gates, is `skipped`
- **WHEN** `tools/ci_required.py` runs
- **THEN** it exits non-zero and names `lab`

### Requirement: Mocked Playwright tests in three shards
WHEN CI runs and the `e2e` area output of job `changes` is `true`, THE `frontend-e2e` job SHALL run the `mocked` Playwright project as three shard jobs with `--shard=1/3`, `--shard=2/3` and `--shard=3/3` and `fail-fast` `false`, while job `frontend` no longer runs the `mocked` project and keeps the UI acceptance runner as its last step.

`req~ci-speed-e2e-shards~1`

Evidence (planned, slice S4): lab/tests/test_ci_gate_tooling.py and the lab shard-partition check of tasks.md S4

#### Scenario: The shard job
- **GIVEN** `ci.yml`
- **WHEN** job `frontend-e2e` is read
- **THEN** it has `if: needs.changes.outputs.e2e == 'true'`, `strategy.fail-fast: false` and matrix `shard: [1, 2, 3]`
- **AND** a step runs `pnpm exec playwright test --project=mocked --shard=${{ matrix.shard }}/3` with `working-directory` `frontend`, after `pnpm exec playwright install --with-deps chromium`

#### Scenario: Job frontend
- **GIVEN** job `frontend` of `ci.yml`
- **WHEN** its steps are read
- **THEN** no step runs `--project=mocked`
- **AND** its last step runs `pnpm exec playwright test --config playwright.acceptance.config.ts --pass-with-no-tests`

#### Scenario: The shards cover every mocked test once
- **GIVEN** the mocked project of `frontend/playwright.config.ts`
- **WHEN** `playwright test --project=mocked --list` runs with `--shard=1/3`, `--shard=2/3` and `--shard=3/3`
- **THEN** the sum of the three totals equals the total without `--shard`

#### Scenario: One shard fails
- **GIVEN** a test of shard 2 fails
- **WHEN** CI runs
- **THEN** shards 1 and 3 still run to the end and `ci-required` fails

### Requirement: Gateway unit tests in two native shards
WHEN CI runs and the `gateway` area output of job `changes` is `true`, THE `gateway-unit` job SHALL run the gateway unit tests outside the compose containers in two shard jobs whose file lists, from `tools/ci_shard.py`, partition the suite, in place of the unit-test step of job `test`.

`req~ci-speed-gateway-unit-shards~1`

Evidence (planned, S5a and S5): lab/tests/test_ci_shard.py, lab/tests/test_ci_gate_tooling.py

#### Scenario: The shard job
- **GIVEN** `ci.yml`
- **WHEN** job `gateway-unit` is read
- **THEN** it has `if: needs.changes.outputs.gateway == 'true'` and matrix `shard: [1, 2]`
- **AND** it restores the environment with `uv sync --locked --project openbinding-gateway --extra test` and runs pytest over the output of `tools/ci_shard.py --shard ${{ matrix.shard }}/2`, with `OPENBINDING_REPO_ROOT` set to the checkout
- **AND** no step runs `docker compose`

#### Scenario: The shards partition the suite
- **GIVEN** the test files collected by `pytest --collect-only -q` in `openbinding-gateway`
- **WHEN** `tools/ci_shard.py --shard 1/2` and `--shard 2/2` run
- **THEN** no file appears in both outputs and their union equals the collected files

#### Scenario: Job test
- **GIVEN** job `test` of `ci.yml`
- **WHEN** its steps are read
- **THEN** it still has the steps "Build and start services", "Run ICSOC generator tests", "Check the OpenAPI snapshot is current", "Run integration tests" and "Show service logs on failure"
- **AND** it has no step "Run unit tests"

### Requirement: Every CI job has a timeout
THE CI workflow SHALL declare `timeout-minutes` on every job, with no value above 45, `changes` at 5, `engines` at 30, `test` at 45 and `frontend` at 45.

`req~ci-speed-job-timeouts~1`

Evidence (planned, slice S3): lab/tests/test_ci_gate_tooling.py

#### Scenario: The timeouts
- **GIVEN** `ci.yml`
- **WHEN** every job is read
- **THEN** each one has an integer `timeout-minutes` between 1 and 45
- **AND** `changes` has 5, `engines` 30, `test` 45 and `frontend` 45

#### Scenario: A hung job
- **GIVEN** a step of `engines` that hangs
- **WHEN** 30 minutes have passed since the job started
- **THEN** GitHub cancels the job and `ci-required` fails
