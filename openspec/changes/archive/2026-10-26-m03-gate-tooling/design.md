# Design: m03-gate-tooling

Status: plan. Every new gate step is report-only until a run into `develop` exits 0 (G1, G6, G9). Facts below were
checked against the repository head and, for external tools, against their release pages (sources in §8).

## 1. Constraints

- Exact versions for anything a step installs or downloads. Setup actions may take a runtime major (`node-version:
  '22'`, `java-version: '21'`, `python-version: '3.11'`); `setup-uv` keeps `version: '0.8.14'` as in the other jobs.
- No new `uses:`. The workflow keeps exactly `actions/checkout@v4`, `actions/setup-python@v5`, `astral-sh/setup-uv@v6`,
  `actions/setup-java@v4` and `actions/setup-node@v4`.
- OpenSpec, OpenFastTrace and import-linter are CI-only: never committed, never in an image.
- Evidence of every requirement is a static test in `lab/tests/test_ci_gate_tooling.py`, which the `lab` job already
  collects (`pytest lab/tests`). Slices are serialized: all touch `ci.yml` and that file.

## 2. Jobs `openspec` and `trace` (S1, G1 and G6)

`openspec` (no `needs`, `timeout-minutes: 10`): checkout with `persist-credentials: false`; `actions/setup-node@v4`
with `node-version: '22'`; `npm install --global @fission-ai/openspec@1.14.3`; `openspec --version`; `openspec
validate --strict --all` with `continue-on-error: true`. The install and version steps fail the job: a broken install
must not look like a report.

`trace` (no `needs`, `timeout-minutes: 10`): checkout with `persist-credentials: false`; `actions/setup-java@v4` with
`distribution: temurin`, `java-version: '21'` (OFT 4.x needs Java 17+); then

```yaml
- name: Download OpenFastTrace 4.11.0
  run: |
    mkdir -p "$RUNNER_TEMP/oft"
    curl --proto '=https' --proto-redir '=https' --retry 3 --fail --location --silent --show-error \
      --output "$RUNNER_TEMP/oft/openfasttrace-4.11.0.jar" \
      https://github.com/itsallcode/openfasttrace/releases/download/4.11.0/openfasttrace-4.11.0.jar
- name: Verify the OpenFastTrace checksum
  run: echo "f094cd314f0fc4236f513f66fb39260a16f72e2320beb6b4fdeb7940b9b8cf87  $RUNNER_TEMP/oft/openfasttrace-4.11.0.jar" | sha256sum -c -
- name: Trace requirements (report-only)
  continue-on-error: true
  run: |
    paths=()
    for path in openspec/specs openbinding-gateway/src openbinding-gateway/tests engines frontend/src acceptance; do
      if [ -e "$path" ]; then paths+=("$path"); else echo "skipped (absent): $path"; fi
    done
    java -jar "$RUNNER_TEMP/oft/openfasttrace-4.11.0.jar" trace -o plain "${paths[@]}"
```

The paths are the G6 argv of `.agentic/project.yaml`, in its order. `acceptance` is absent until S4. OFT exits 1 when
the trace has defects; with no tags in the code base (constitution 3) the first runs are expected red, hence
report-only.

Hardening decided in review round 1 (applies to the whole workflow and the two new jobs):

- Top-level `permissions: contents: read`, so no job holds a write token.
- `persist-credentials: false` on the checkout of jobs `openspec` and `trace`, and `timeout-minutes: 10` on both.
- The OFT download accepts only HTTPS, also across redirects, and retries: `curl --proto '=https' --proto-redir
  '=https' --retry 3` (snippet above). The checksum step still decides whether the jar is used.
- In job `lab`, the API acceptance step and the import-linter step carry `if: ${{ !cancelled() }}`, so a failure of
  the lab tests does not hide the acceptance and import-linter results (they run unless the run is cancelled).

OpenFastTrace is licensed GPL-3.0. It is a CI-only tool: downloaded at run time, never committed to the repository
and never distributed in an image or an artifact (requirement `tools-not-shipped`).

## 3. `.agentic/project.yaml` (S1)

Only comment lines, right after each entry; argv and `todo: true` stay:

```yaml
    - {name: openspec-validate, cwd: ., argv: [openspec, validate, --strict], needs: [openspec-cli], todo: true}
    # M0.3: CI job `openspec` runs `openspec validate --strict --all` (report-only). This argv lacks --all.
    # todo: true stays until a CI run into develop exits 0 and the factory runner (F1) has openspec-cli.
    ...
    - {name: oft-trace, ...}
    # M0.3: CI job `trace` runs OpenFastTrace 4.11.0 over these paths, skipping absent ones (report-only).
    # todo: true stays until a CI run into develop exits 0 and the factory runner (F1) has the jar.
```

`.agentic/**` is R11: the S1 PR needs the owner's approval (G10 owner-only paths).

## 4. import-linter (S2, G9)

`openbinding-gateway/.importlinter` states the layer rule of ADR-0012 and constitution 6.1. It does **not** mirror
`tests/test_architecture_layers.py` exactly (the test-function name keeps "mirrors" only as its id):

- The test checks the direct imports of each module against an allow-list; import-linter checks whole import chains
  (a module that reaches a forbidden layer through other modules breaks the contract too).
- The contracts mirror neither `ALLOWED_LEGACY` (the frozen, listed exceptions of the test) nor the composition root
  `main`, which the test exempts.
- The `integrations` contract is a deny-list, so it is a subset of the test's allow-list for `integrations`.
- ARCHITECTURE §4.2 and constitution 6.5 are not the source: their GAP stays open until the legacy refactors of
  ROADMAP M9.2.

```ini
[importlinter]
root_package = openbinding_gateway

[importlinter:contract:layers]
name = routes -> services -> repositories | integrations -> db
type = layers
containers =
    openbinding_gateway
layers =
    routes
    services
    repositories | integrations
    db

[importlinter:contract:no-routes]
name = services, domain and jobs do not import routes
type = forbidden
source_modules =
    openbinding_gateway.services
    openbinding_gateway.domain
    openbinding_gateway.jobs
forbidden_modules =
    openbinding_gateway.routes

[importlinter:contract:integrations]
name = integrations depend on nothing above them
type = forbidden
source_modules =
    openbinding_gateway.integrations
forbidden_modules =
    openbinding_gateway.routes
    openbinding_gateway.services
    openbinding_gateway.repositories
    openbinding_gateway.db
    openbinding_gateway.domain
    openbinding_gateway.jobs
```

The `|` siblings must be independent, which is stricter than the architecture test.

First CI run: `Contracts: 1 kept, 2 broken`. The broken ones are `layers` and `no-routes`, through the chains
`artifacts`, `reports`, `study_jobs`, `analysis_jobs` and `telemetry` -> `main`, and `platform_models` -> `artifacts`;
`integrations` is kept. The gate stays report-only, and blocking waits for the legacy refactors of ROADMAP M9.2 (the ADR-0012 ratchets shrink).

Architecture debt to follow up: `telemetry -> main` (services and jobs reaching the composition root). It is not
fixed here and not exempted in the contracts.

- Dependency: `[dependency-groups] lint = ["import-linter==2.15"]` (2.15 is the PyPI release of 2026-09-04,
  Python ≥ 3.10). A group, not the `test` extra: the gateway image installs `".[test]"`
  (`openbinding-gateway/Dockerfile`), and only the `dev` group is synced by default, so no other job or image gets it.
- CI: last step of the `lab` job, `working-directory: openbinding-gateway`, `run: uv run --locked --extra test --group
  lint lint-imports --config .importlinter`, `continue-on-error: true`, `if: ${{ !cancelled() }}`. After the lab
  tests (and the API acceptance step of S4), so its sync cannot change what they ran on. Exit 1 means a broken
  contract.
- `uv.lock` is regenerated through a registered check (`uv lock`, needs the package index); CI reads it with uv
  0.8.14 (`--locked`).

## 5. ESLint boundaries (S2, G9)

- `frontend/package.json`: `"eslint-plugin-boundaries": "7.3.0"` in `devDependencies` (exact, no range);
  `pnpm-lock.yaml` regenerated through a registered check. 7.3.0 peers on `eslint >=6`.
- `frontend/eslint.config.js`: one block for `src/**/*.{ts,tsx}` with `plugins: { boundaries }`, `settings:
  {'boundaries/elements': [{ type: 'page', pattern: 'src/pages/*', capture: ['name'] }]}`, the node resolver
  with `.ts`/`.tsx` extensions in `settings['import/resolver']` (no new resolver package), and `boundaries/dependencies` at `'warn'` disallowing a
  `page` importing a `page` of another `name`. In 7.x `boundaries/element-types` is deprecated; whether 7.3.0 takes
  the list under `rules` or `policies` is not settled by its docs, so S2 uses the key the installed package accepts
  without a deprecation warning.
- Report-only: severity `warn` and `pnpm lint` (`eslint .`) has no `--max-warnings`, so the existing `Lint and test
  frontend` step reports the count and fails only on errors. A probe check in S2 proves the rule fires (tasks.md).
- Baseline: about 316 page-to-page warnings, read from a temporary run at severity `error` (not committed; the
  committed severity is `warn`). The trigger to raise the severity to `error` is ROADMAP M9.3.
- Follow-up, owner path and not done here: one line in `docs/ARCHITECTURE.md` §5.1 saying that pages do not import
  other pages.
- Images: no Dockerfile changes. The `base` stage of `frontend/Dockerfile` (`dev`, `build`) and
  `frontend/Dockerfile.e2e` run `pnpm install --frozen-lockfile`, so both get the plugin from the lockfile; the e2e
  image of the lab therefore changes, which the S2 PR states. `prod-assets`, `prod` and `lab` copy only `/app/dist`.
  `lab/tests` (memory sum, users, the Playwright image anchor in `test_lab_compose.py`) must stay green.

## 6. Job `bim-toolchain` (S3)

The tests live in `bim-toolchain/packages/{bim-core,bim-service,bim-client}/tests`; the goldens in
`bim-toolchain/golden/` are checked by `bim-toolchain/tools/baseline_core.py --check` and the golden tests of bim-core
(the corpus is found at the repository root, `BIM_CORPUS_ROOT` default). There is no top-level `bim-service/`. By
search, the third-party imports of those packages and tests are `jsonschema`, `lxml`, `yaml`, `fastapi`/`starlette`,
`pydantic`, `uvicorn`, `httpx` and `pytest`, all in the gateway's locked environment with the `test` extra;
`bim-toolchain/conftest.py` puts every `packages/*/src` on `sys.path`, so `bim_service` (not a gateway dependency)
imports from source. S3's first check confirms it by running.

Steps: checkout; `python3 bim-toolchain/tools/xsd_inventory.py --ensure` (as `bim-corpus`); setup-python `'3.11'`;
setup-uv `'0.8.14'`; `uv sync --locked --project openbinding-gateway --extra test`; then, with `working-directory:
bim-toolchain` and `PYTHONPATH: packages/bim-core/src:packages/bim-service/src:packages/bim-client/src` (as G5
`bim-toolchain`):

- `../openbinding-gateway/.venv/bin/python -m pytest -p no:cacheprovider --rootdir=. -rs packages/bim-core/tests
  packages/bim-service/tests packages/bim-client/tests --deselect
  packages/bim-service/tests/analysis/test_analysis_b8_evidence.py::test_the_throughput_cost_of_a_short_switch_interval
  --deselect
  'packages/bim-service/tests/analysis/test_analysis_b8_probe.py::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]'`
- `../openbinding-gateway/.venv/bin/python tools/baseline_core.py --check`

Two tests are deselected, for the same reason: both are timing measurements whose outcome depends on the shared runner's
CPU, not correctness tests. `test_the_throughput_cost_of_a_short_switch_interval` is a loose throughput measurement: on
a shared 4-CPU runner it measured 47.6% of the baseline against a 50% bound (19326 against 20320).
`test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]` is a strict xfail that reproduces a
GIL-switching latency defect and XPASSed on the runner. Their results are not deterministic. The toolchain's own CI keeps
running both; nothing else is deselected. Follow-up: make these measurements robust or mark them in the toolchain, then
remove the two `--deselect` options.

No `continue-on-error`: these are tests. The workflow triggers on every pull request into `main`/`develop` and has no
path filter (a filter would need a new action), which covers "every change under `bim-toolchain/`". `tools/` tests
(packaging, wheel builds) stay in G5 and in the toolchain's own CI. The job is removed at the extraction.

## 7. Acceptance runners (S4)

- `acceptance/api/pytest.ini` (`[pytest]`, `testpaths = .`, `pythonpath = ../../openbinding-gateway/src`) and
  `acceptance/api/conftest.py` with a `pytest_sessionfinish` hook that sets `session.exitstatus = 0` when it is
  `pytest.ExitCode.NO_TESTS_COLLECTED` (5). Any other status passes through. Command, from the root:
  `openbinding-gateway/.venv/bin/python -m pytest -c acceptance/api/pytest.ini acceptance/api -q`, a step of the
  `lab` job after the lab tests.
- `acceptance/ui/.gitkeep` and `frontend/playwright.acceptance.config.ts` (`testDir: '../acceptance/ui'`, the mocked
  project's Vite web server unless `PLAYWRIGHT_BASE_URL` is set, `retries: 0`, `outputDir:
  'test-results/acceptance'`). Command, last step of the `frontend` job: `pnpm exec playwright test --config
  playwright.acceptance.config.ts --pass-with-no-tests` (without the flag Playwright fails on "No tests found").
- `frontend/src/test/e2eSpecs.test.ts`: the new config joins `configs`, so Vitest type-checks it.
- `acceptance/README.md` and `TESTING.md` §2: layout `acceptance/api/<capability>/test_<slug>.py` and
  `acceptance/ui/<capability>/<slug>.spec.ts`, both commands, exit 0 without tests, only the test-designer writes
  tests (G4). This answers the TESTING.md open question: one top-level `acceptance/` with one runner per surface.
- `acceptance/**` is the test-designer's path (G4), so its four files are written by a test-designer task (S4b); the
  rest of S4 by the implementer (S4a). Both ship in one PR.
- Not in images: the frontend build context is `frontend/`, so `acceptance/` is in no image. The config file enters
  the `dev`/`build`/e2e stages through `COPY . .`, as `playwright.config.ts` does.

## 8. Evidence file

`lab/tests/test_ci_gate_tooling.py`, PyYAML (a gateway dependency) and the standard library only. Helpers assert,
never raise `KeyError`: `_ci()` loads `ci.yml` (PyYAML reads the key `on` as `True`); `_job(name)` asserts the job
exists; `_step(job, text)` asserts one step whose `run` contains `text` and returns it; `_read(path)` asserts the file
exists. Each test carries `# [utest->req~gate-tooling-<slug>~1]`. G6 does not trace `lab/` (§9), so these tags are
not traced yet. Tests that pass on the base are guards and are named in tasks.md.

Sources for external facts: npm registry `@fission-ai/openspec/1.14.3` and `eslint-plugin-boundaries/7.3.0`; GitHub
release API `itsallcode/openfasttrace` 4.11.0 and its `.jar.sha256` asset (same SHA-256 as above); PyPI
`import-linter` JSON (2.15); playwright.dev/docs/test-cli (`--pass-with-no-tests`).

## 9. Not fixed here (risks)

| Item | Evidence | Effect here |
|---|---|---|
| `ci.yml` `check_bim_corpus.py --expected 83` vs 82 | `.agentic/project.yaml` G5 `bim-corpus` and `TESTING.md` say 82; `baseline_core.py` defaults to `--expected 82` | the S3 goldens step may fail on the count; S3 then checkpoints, it does not add `continue-on-error` |
| uv 0.8.14 vs 0.8.22 | CI `setup-uv` 0.8.14; `openbinding-gateway/Dockerfile` copies uv 0.8.22 | the S2 lock must pass `uv sync --locked` under 0.8.14 |
| Actions pinned by tag | constitution 10.5 GAP | unchanged; no action added. Repository-wide follow-up: pin every action by commit SHA (finding SEC-006) |
| Constitution GAP lines 1, 2, 3, 6 | `constitution.md` (owner-only) | stay until the gates block |
| OpenSpec transitive npm dependencies unpinned, `--ignore-scripts` not used | `npm install --global` pins the top package only and runs install scripts of its dependencies (finding SEC-002) | a transitive release can change a run or run code in it; report-only and `contents: read` limit it |
| `bim-toolchain` job weaker than the toolchain's own CI | the job does not fail on skipped tests and runs no OpenAPI or consumer-fixture check | regressions those checks catch pass here; they stay in the toolchain's CI and G5 |
| G4 does not cover `frontend/playwright.acceptance.config.ts` | its shape is pinned by a lab test; adding it to the G4 paths of `.agentic/project.yaml` is an owner decision (R11) | the implementer, not the test-designer, owns that config |
| `--pass-with-no-tests` and the exit-5 mapping | the Playwright flag and the `pytest_sessionfinish` hook of `acceptance/api/conftest.py` make empty runners pass | both are dropped when the first acceptance test of each surface lands |
| Import-linter contracts and `ALLOWED_LEGACY` | §4: chains, no `ALLOWED_LEGACY`, no `main` exemption; first run 1 kept, 2 broken | report-only; blocking waits for ROADMAP M9.2 (ADR-0012 ratchets). `telemetry -> main` (`telemetry.py` imports the app from `main`) is architecture debt to be triaged |
| Two timing-dependent `bim-toolchain` tests deselected (§6) | throughput ratio 47.6% against the 50% bound; a strict xfail that XPASSed on the runner | not run in this job; remove the two `--deselect` options when the toolchain makes its B8 timing tests robust |
| Possible flaky gateway test | `tests/test_engine_cancel_contract.py::test_the_credential_of_another_tenant_cannot_stop_the_job_and_the_404_is_not_retried` failed once in CI on a gateway file this change does not touch | flaky, to triage; not addressed here |
| G6 paths do not include `lab/` | `.agentic/project.yaml` G6 | the evidence tags of this change are not traced |
| UI specs outside `frontend/` | `testDir: '../acceptance/ui'` | a spec there may not resolve `@playwright/test` from `frontend/node_modules`; proved by the first UI acceptance test |
| G1 argv lacks `--all` | `.agentic/project.yaml` G1 | comment only (§3) |

## Requirements

| Id | Intent | Evidence |
|---|---|---|
| `req~gate-tooling-openspec-job~1` | CI job installs OpenSpec 1.14.3 on Node 22 and validates all | `lab/tests/test_ci_gate_tooling.py::test_openspec_job_installs_pinned_cli_and_validates_all` |
| `req~gate-tooling-openspec-report-only~1` | only the validate step may fail without failing the job | `lab/tests/test_ci_gate_tooling.py::test_openspec_validate_is_report_only` |
| `req~gate-tooling-trace-download~1` | OFT 4.11.0 jar downloaded to `$RUNNER_TEMP/oft` and checksum-verified, hard-failing | `lab/tests/test_ci_gate_tooling.py::test_trace_job_downloads_and_verifies_pinned_jar` |
| `req~gate-tooling-trace-paths~1` | trace over the existing G6 paths, report-only | `lab/tests/test_ci_gate_tooling.py::test_trace_step_covers_g6_paths_report_only` |
| `req~gate-tooling-tools-not-shipped~1` | gate tools neither committed nor in images | `lab/tests/test_ci_gate_tooling.py::test_gate_tools_not_committed_or_in_images` |
| `req~gate-tooling-pinned-steps~1` | exact versions, no new actions | `lab/tests/test_ci_gate_tooling.py::test_gate_jobs_pin_versions_and_add_no_actions` |
| `req~gate-tooling-project-yaml-notes~1` | G1/G6 stay `todo: true` with comment lines | `lab/tests/test_ci_gate_tooling.py::test_project_yaml_g1_g6_stay_todo_with_notes` |
| `req~gate-tooling-import-linter-contract~1` | import-linter contracts state the gateway layer rule (ADR-0012, constitution 6.1) | `lab/tests/test_ci_gate_tooling.py::test_importlinter_contract_mirrors_layers` |
| `req~gate-tooling-import-linter-dev-only~1` | import-linter 2.15 locked in the `lint` group only | `lab/tests/test_ci_gate_tooling.py::test_import_linter_is_locked_dev_only` |
| `req~gate-tooling-import-linter-report-only~1` | `lint-imports` runs report-only in the `lab` job | `lab/tests/test_ci_gate_tooling.py::test_import_linter_step_is_report_only` |
| `req~gate-tooling-eslint-boundaries~1` | page-to-page imports warn, plugin 7.3.0 dev-only | `lab/tests/test_ci_gate_tooling.py::test_eslint_boundaries_warns_page_to_page` |
| `req~gate-tooling-frontend-images~1` | the plugin enters images only through the frozen install | `lab/tests/test_ci_gate_tooling.py::test_frontend_images_get_plugin_only_by_frozen_install` |
| `req~gate-tooling-bim-toolchain-tests~1` | bim-toolchain package tests on every PR, gateway env | `lab/tests/test_ci_gate_tooling.py::test_bim_toolchain_job_runs_package_tests` |
| `req~gate-tooling-bim-toolchain-goldens~1` | goldens compared on every PR | `lab/tests/test_ci_gate_tooling.py::test_bim_toolchain_job_checks_goldens` |
| `req~gate-tooling-api-runner~1` | pytest runner exits 0 without tests, runs in `lab` | `lab/tests/test_ci_gate_tooling.py::test_api_runner_passes_empty_and_runs_in_lab` |
| `req~gate-tooling-ui-runner~1` | Playwright runner with `--pass-with-no-tests` in `frontend` | `lab/tests/test_ci_gate_tooling.py::test_ui_runner_passes_empty_in_frontend_job` |
| `req~gate-tooling-acceptance-docs~1` | runners and G4 ownership documented | `lab/tests/test_ci_gate_tooling.py::test_acceptance_docs_name_runners_and_writer` |
