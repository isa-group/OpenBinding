## ADDED Requirements

### Requirement: OpenSpec CLI job
WHEN a pull request into `main` or `develop` runs CI, THE `openspec` job SHALL set up Node 22, install `@fission-ai/openspec@1.14.3` with `npm install --global`, print `openspec --version` and run `openspec validate --strict --all`.

`req~gate-tooling-openspec-job~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_openspec_job_installs_pinned_cli_and_validates_all

#### Scenario: The job in the workflow
- **GIVEN** `.github/workflows/ci.yml`
- **WHEN** it is parsed
- **THEN** job `openspec` sets up Node with `node-version` `22`
- **AND** its steps run `npm install --global @fission-ai/openspec@1.14.3`, `openspec --version` and `openspec validate --strict --all`, in that order

### Requirement: OpenSpec validation is report-only
THE `openspec` job SHALL run `openspec validate --strict --all` in a step with `continue-on-error: true` until a CI run into `develop` exits 0, and SHALL NOT mark its install or version step `continue-on-error`, so a broken install fails the job.

`req~gate-tooling-openspec-report-only~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_openspec_validate_is_report_only

#### Scenario: Validation errors are reported, not blocking
- **GIVEN** a pull request whose specs fail `openspec validate --strict --all`
- **WHEN** the `openspec` job runs
- **THEN** the validate step logs the errors and the job does not fail

#### Scenario: Install and version steps block
- **GIVEN** `ci.yml`
- **WHEN** the steps of job `openspec` are read
- **THEN** only the validate step has `continue-on-error: true`

### Requirement: Pinned OpenFastTrace download
WHEN CI runs, THE `trace` job SHALL set up Temurin Java 21, download `openfasttrace-4.11.0.jar` from the GitHub release 4.11.0 of `itsallcode/openfasttrace` into `$RUNNER_TEMP/oft`, and verify it with `sha256sum -c` against `f094cd314f0fc4236f513f66fb39260a16f72e2320beb6b4fdeb7940b9b8cf87`; IF the download or the check fails, THEN the job SHALL fail.

`req~gate-tooling-trace-download~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_trace_job_downloads_and_verifies_pinned_jar

#### Scenario: Download and checksum steps
- **GIVEN** `ci.yml`
- **WHEN** job `trace` is read
- **THEN** it sets up Java with `distribution` `temurin` and `java-version` `21`
- **AND** one step downloads `https://github.com/itsallcode/openfasttrace/releases/download/4.11.0/openfasttrace-4.11.0.jar` into `$RUNNER_TEMP/oft`, and a later step runs `sha256sum -c` with the checksum above
- **AND** neither step has `continue-on-error`

#### Scenario: Tampered jar
- **GIVEN** a downloaded file whose SHA-256 differs from the checksum
- **WHEN** the checksum step runs
- **THEN** `sha256sum -c` exits non-zero and the job fails before any trace

### Requirement: Trace over the G6 paths, report-only
THE `trace` job SHALL run the verified jar with `trace -o plain` over those of `openspec/specs`, `openbinding-gateway/src`, `openbinding-gateway/tests`, `engines`, `frontend/src` and `acceptance` that exist, in that order, in a step with `continue-on-error: true` until a CI run into `develop` exits 0.

`req~gate-tooling-trace-paths~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_trace_step_covers_g6_paths_report_only

#### Scenario: An absent path is skipped
- **GIVEN** a checkout without `acceptance/`
- **WHEN** the trace step runs
- **THEN** it logs `acceptance` as skipped and traces the five other paths

#### Scenario: Trace defects do not block
- **GIVEN** requirements without coverage tags
- **WHEN** the trace step reports defects and exits non-zero
- **THEN** the `trace` job does not fail

### Requirement: Gate tools stay CI-only
THE repository SHALL NOT commit the OpenFastTrace jar, and no Dockerfile in it SHALL install or copy OpenSpec, OpenFastTrace or import-linter.

`req~gate-tooling-tools-not-shipped~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_gate_tools_not_committed_or_in_images

#### Scenario: Repository tree and Dockerfiles
- **GIVEN** the repository tree without `.git`, `node_modules` and `.venv`
- **WHEN** it is searched
- **THEN** no file named `openfasttrace*.jar` exists
- **AND** no `Dockerfile*` contains `openfasttrace`, `@fission-ai/openspec`, `import-linter`, `importlinter` or `lint-imports`

### Requirement: Exact versions and no new actions
THE gate tooling jobs SHALL name an exact version for every package or file a step installs or downloads, setup actions taking at most a runtime major such as Node `22` or Java `21`, and THE workflow SHALL use no action other than `actions/checkout@v4`, `actions/setup-python@v5`, `astral-sh/setup-uv@v6`, `actions/setup-java@v4` and `actions/setup-node@v4`.

`req~gate-tooling-pinned-steps~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_gate_jobs_pin_versions_and_add_no_actions

#### Scenario: Pinned installs
- **GIVEN** jobs `openspec` and `trace`
- **WHEN** their `run` steps are read
- **THEN** every `npm install` names `<package>@<major>.<minor>.<patch>` and every download URL names `4.11.0`

#### Scenario: No new action
- **GIVEN** `ci.yml`
- **WHEN** every `uses:` value is collected
- **THEN** the set is a subset of the five actions above

### Requirement: Factory configuration notes for G1 and G6
THE G1 `openspec-validate` and G6 `oft-trace` entries of `.agentic/project.yaml` SHALL keep their argv and `todo: true` until a CI run into `develop` exits 0 and the factory runner F1 has the tools, and each SHALL be followed by comment lines saying so; the G1 comment SHALL state that its argv lacks `--all`.

`req~gate-tooling-project-yaml-notes~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_project_yaml_g1_g6_stay_todo_with_notes

#### Scenario: Entries unchanged, comments added
- **GIVEN** `.agentic/project.yaml`
- **WHEN** it is parsed and its lines are read
- **THEN** `openspec-validate` has argv `[openspec, validate, --strict]` and `oft-trace` its six paths, both with `todo: true`
- **AND** the comment lines right after each entry name `todo: true` and F1, and those after G1 name `--all`

### Requirement: import-linter layers contract
THE gateway SHALL declare in `openbinding-gateway/.importlinter`, for root package `openbinding_gateway`, three contracts: a layers contract, a forbidden contract keeping `services`, `domain` and `jobs` off `routes`, and a forbidden contract keeping `integrations` off the layers above it.

`req~gate-tooling-import-linter-contract~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_importlinter_contract_mirrors_layers

#### Scenario: Contracts in the file
- **GIVEN** `openbinding-gateway/.importlinter`
- **WHEN** it is read with `configparser`
- **THEN** `root_package` is `openbinding_gateway`
- **AND** the layers contract lists `routes`, `services`, `repositories | integrations`, `db` (top to bottom)
- **AND** the `no-routes` contract forbids `routes` from `services`, `domain` and `jobs`
- **AND** the `integrations` contract forbids `routes`, `services`, `repositories`, `db`, `domain` and `jobs` from `integrations`

#### Scenario: A service importing a route
- **GIVEN** a module of `services/` that imports `openbinding_gateway.routes`
- **WHEN** `lint-imports --config .importlinter` runs
- **THEN** it reports the `no-routes` contract as broken and exits 1

### Requirement: import-linter is a locked development dependency
THE gateway SHALL pin `import-linter==2.15` in the dependency group `lint` of `openbinding-gateway/pyproject.toml`, locked in `openbinding-gateway/uv.lock`, and SHALL NOT list it in `[project].dependencies` or the `test` extra, which the gateway image installs.

`req~gate-tooling-import-linter-dev-only~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_import_linter_is_locked_dev_only

#### Scenario: Group, lock and image
- **GIVEN** `pyproject.toml`, `uv.lock` and `openbinding-gateway/Dockerfile`
- **WHEN** they are read
- **THEN** `[dependency-groups].lint` contains `import-linter==2.15` and `uv.lock` has package `import-linter` version `2.15`
- **AND** neither `[project].dependencies` nor the `test` extra names `import-linter`, and the Dockerfile installs `".[test]"` with no `--group`

### Requirement: import-linter runs report-only in CI
WHEN the `lab` job runs, THE job SHALL run `uv run --locked --extra test --group lint lint-imports --config .importlinter` from `openbinding-gateway`, after the lab tests, in a step with `continue-on-error: true` until a CI run into `develop` exits 0.

`req~gate-tooling-import-linter-report-only~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_import_linter_step_is_report_only

#### Scenario: Broken contracts are reported
- **GIVEN** a gateway that breaks a contract
- **WHEN** the `lab` job runs
- **THEN** the import-linter step logs the broken contract and the job does not fail

#### Scenario: Step order
- **GIVEN** job `lab` in `ci.yml`
- **WHEN** its steps are read
- **THEN** the import-linter step comes after the step that runs `pytest lab/tests`

### Requirement: ESLint boundaries warn on page-to-page imports
THE frontend SHALL list `eslint-plugin-boundaries` `7.3.0`, exact, in `devDependencies` only, and `frontend/eslint.config.js` SHALL declare each `src/pages/*` folder a `page` element and report an import from one page into another at severity `warn`, never `error`, so `pnpm lint` reports them without failing.

`req~gate-tooling-eslint-boundaries~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_eslint_boundaries_warns_page_to_page

#### Scenario: Dependency and configuration
- **GIVEN** `frontend/package.json` and `frontend/eslint.config.js`
- **WHEN** they are read
- **THEN** `devDependencies` has `"eslint-plugin-boundaries": "7.3.0"` and `dependencies` does not name it
- **AND** the config imports `eslint-plugin-boundaries`, declares element type `page` with pattern `src/pages/*`, sets its `boundaries/` rule to `warn` and sets no `boundaries/` rule to `error`
- **AND** the `lint` script has no `--max-warnings`

#### Scenario: A page imports another page
- **GIVEN** `src/pages/About/Probe.tsx` importing `../Account/Account`
- **WHEN** ESLint lints it
- **THEN** it prints a `boundaries/` warning and exits 0

### Requirement: The plugin reaches images only through the frozen install
THE frontend images SHALL get `eslint-plugin-boundaries` only through the existing `pnpm install --frozen-lockfile` of the `frontend/Dockerfile` base stage (`dev`, `build`) and of `frontend/Dockerfile.e2e`, so the lab e2e image gains it, with `pnpm-lock.yaml` resolving 7.3.0, while the served `prod-assets`, `prod` and `lab` stages copy only `dist`.

`req~gate-tooling-frontend-images~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_frontend_images_get_plugin_only_by_frozen_install

#### Scenario: Lockfile and stages
- **GIVEN** `frontend/pnpm-lock.yaml`, `frontend/Dockerfile` and `frontend/Dockerfile.e2e`
- **WHEN** they are read
- **THEN** the lockfile resolves `eslint-plugin-boundaries` `7.3.0` as a devDependency of the importer
- **AND** both Dockerfiles run `pnpm install --frozen-lockfile` and neither names `eslint-plugin-boundaries`
- **AND** in `frontend/Dockerfile` the stages `prod-assets`, `prod` and `lab` run no package install and copy from `build` only `/app/dist`

### Requirement: bim-toolchain tests on every pull request
WHEN a pull request into `main` or `develop` runs CI, THE `bim-toolchain` job SHALL, with no path filter, run the pytest suites of the `bim-core`, `bim-service` and `bim-client` packages with the gateway's locked environment, and SHALL fail on any test failure.

`req~gate-tooling-bim-toolchain-tests~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_bim_toolchain_job_runs_package_tests

#### Scenario: The job in the workflow
- **GIVEN** `ci.yml`
- **WHEN** it is parsed
- **THEN** the workflow triggers on `pull_request` with no `paths` filter and job `bim-toolchain` has no `if`
- **AND** its steps fetch and verify the OMG BPMN XSDs with `xsd_inventory.py --ensure`, restore the gateway's locked environment with `uv sync --locked --project openbinding-gateway --extra test`, and run `../openbinding-gateway/.venv/bin/python -m pytest` over `packages/bim-core/tests`, `packages/bim-service/tests` and `packages/bim-client/tests` with `working-directory` `bim-toolchain`
- **AND** no step has `continue-on-error`
- **AND** the pytest command also carries exactly two `--deselect` options, for `packages/bim-service/tests/analysis/test_analysis_b8_evidence.py::test_the_throughput_cost_of_a_short_switch_interval` and `packages/bim-service/tests/analysis/test_analysis_b8_probe.py::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]` (timing-dependent, design.md section 6), and nothing else is deselected

#### Scenario: A failing bim-service test
- **GIVEN** a pull request that breaks a test of `packages/bim-service/tests`
- **WHEN** the `bim-toolchain` job runs
- **THEN** the job fails

### Requirement: bim-toolchain goldens on every pull request
WHEN the `bim-toolchain` job runs, THE job SHALL compare the checked-in corpus with the goldens of `bim-toolchain/golden/` through `tools/baseline_core.py --check`, run from `bim-toolchain/` with the gateway environment's Python, and fail on a mismatch, until the toolchain moves to `isa-group/bim-toolchain`.

`req~gate-tooling-bim-toolchain-goldens~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_bim_toolchain_job_checks_goldens

#### Scenario: Goldens step
- **GIVEN** job `bim-toolchain` in `ci.yml`
- **WHEN** its steps are read
- **THEN** one step runs `../openbinding-gateway/.venv/bin/python tools/baseline_core.py --check` with `working-directory` `bim-toolchain` and no `continue-on-error`

#### Scenario: A changed IR
- **GIVEN** a pull request that changes the compiled IR of a corpus package without regenerating its golden
- **WHEN** the goldens step runs
- **THEN** it exits non-zero and the job fails

### Requirement: API acceptance runner
THE repository SHALL provide `acceptance/api/pytest.ini` and `acceptance/api/conftest.py` such that `pytest -c acceptance/api/pytest.ini acceptance/api` exits 0 when no test is collected or selected (exit code 5 mapped to 0 by a `pytest_sessionfinish` hook), keeps every other exit code, and THE `lab` job SHALL run it with the gateway environment.

`req~gate-tooling-api-runner~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_api_runner_passes_empty_and_runs_in_lab

#### Scenario: No acceptance test yet
- **GIVEN** `acceptance/api` with only `pytest.ini` and `conftest.py`
- **WHEN** `python -m pytest -c acceptance/api/pytest.ini acceptance/api -q` runs from the repository root
- **THEN** it exits 0

#### Scenario: Nothing selected
- **GIVEN** `acceptance/api`, with or without tests
- **WHEN** the runner runs with `-k zz_selects_nothing`
- **THEN** it exits 0

#### Scenario: The step in CI
- **GIVEN** job `lab` in `ci.yml`
- **WHEN** its steps are read
- **THEN** one step runs `openbinding-gateway/.venv/bin/python -m pytest -c acceptance/api/pytest.ini acceptance/api` without `continue-on-error`

### Requirement: UI acceptance runner
THE frontend SHALL provide `frontend/playwright.acceptance.config.ts` with `testDir` `../acceptance/ui`, and THE `frontend` job SHALL run `pnpm exec playwright test --config playwright.acceptance.config.ts --pass-with-no-tests` after installing Chromium, so the runner exits 0 while `acceptance/ui` holds only `.gitkeep`.

`req~gate-tooling-ui-runner~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_ui_runner_passes_empty_in_frontend_job

#### Scenario: Config, folder and step
- **GIVEN** the repository
- **WHEN** `frontend/playwright.acceptance.config.ts`, `acceptance/ui/` and job `frontend` of `ci.yml` are read
- **THEN** the config sets `testDir: '../acceptance/ui'`, `acceptance/ui/.gitkeep` exists, and a step after `playwright install` runs the command above with `working-directory` `frontend`

#### Scenario: No UI acceptance test yet
- **GIVEN** `acceptance/ui` with only `.gitkeep`
- **WHEN** the step runs
- **THEN** Playwright finds no test and exits 0

### Requirement: Acceptance runners are documented
THE repository SHALL describe in `acceptance/README.md` and in `TESTING.md` §2 the two acceptance runners, their commands, that they exit 0 without tests, and that only the test-designer writes tests under `acceptance/` (G4).

`req~gate-tooling-acceptance-docs~1`

Evidence: lab/tests/test_ci_gate_tooling.py::test_acceptance_docs_name_runners_and_writer

#### Scenario: README and TESTING
- **GIVEN** `acceptance/README.md` and `TESTING.md`
- **WHEN** they are read
- **THEN** both contain `pytest -c acceptance/api/pytest.ini` and `playwright.acceptance.config.ts`, and both name the test-designer
- **AND** the §2 heading of `TESTING.md` no longer says "to be created"
