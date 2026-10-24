# Tasks: m03-gate-tooling

Serialized: S1 → S2 → S3 → S4. Every slice edits `.github/workflows/ci.yml` and appends its tests to
`lab/tests/test_ci_gate_tooling.py`, so they never run in parallel. Each slice writes its tests first, is ≤ 300
non-test diff lines (lockfiles are generated paths) and is one PR into `develop`. Role: implementer with the role's
default settings, unless stated. Risk: high for every slice by path (R10 `.github/**`; S1 also R11, S2 also R7), although the
behaviour added is report-only. Read-only context for all: this change, `.agentic/project.yaml`, `ci.yml`,
`openbinding-gateway/tests/test_architecture_layers.py`, `docs/ARCHITECTURE.md` §4–§5.

qa_run has no working directory, so every check is a `bash -c` argv from the repository root. The pytest argv of a
slice is `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest ../lab/tests/test_ci_gate_tooling.py -q -k '<expr>'"]`,
with `<expr>` the slice's expression below (full test names: a short substring would also match the module name
`test_ci_gate_tooling.py`). red_before runs the slice's tests on the base files and must fail with `AssertionError`
only (the helpers of design.md §8 assert; no `KeyError`, import or collection error).

Full lab suite, used as a green check by every slice:
`["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest ../lab/tests -q"]`.

## S1. Jobs `openspec` and `trace`, project.yaml notes (~55 non-test lines + ~130 test lines; turn budget 40)

- Owned: `.github/workflows/ci.yml`, `.agentic/project.yaml` (comment lines only; R11, owner approval in the PR),
  `lab/tests/test_ci_gate_tooling.py` (created with the helpers of design.md §8).
- Requirements: `openspec-job`, `openspec-report-only`, `trace-download`, `trace-paths`, `tools-not-shipped`,
  `pinned-steps`, `project-yaml-notes` (design.md §2–§3).
- [ ] 1.1 Tests: `test_openspec_job_installs_pinned_cli_and_validates_all`, `test_openspec_validate_is_report_only`,
  `test_trace_job_downloads_and_verifies_pinned_jar`, `test_trace_step_covers_g6_paths_report_only`,
  `test_gate_tools_not_committed_or_in_images`, `test_gate_jobs_pin_versions_and_add_no_actions`,
  `test_project_yaml_g1_g6_stay_todo_with_notes`. Expected green on the base: `test_gate_tools_not_committed_or_in_images`
  (guard); every other one red.
- [ ] 1.2 `ci.yml`: jobs `openspec` and `trace` as in design.md §2.
- [ ] 1.3 `.agentic/project.yaml`: the comment lines of design.md §3; no other byte changes.
- `-k`: `test_openspec_job_installs_pinned_cli_and_validates_all or test_openspec_validate_is_report_only or test_trace_job_downloads_and_verifies_pinned_jar or test_trace_step_covers_g6_paths_report_only or test_gate_tools_not_committed_or_in_images or test_gate_jobs_pin_versions_and_add_no_actions or test_project_yaml_g1_g6_stay_todo_with_notes`
- Checks: red_before and green with the argv above; the full lab suite. MRP evidence: the PR's CI run shows both jobs,
  `openspec --version` printing `1.14.3`, `sha256sum` printing `OK`, and the trace and validate reports.

## S2. import-linter and ESLint boundaries (~70 non-test lines + ~120 test lines + lockfiles; turn budget 50)

- Owned: `.github/workflows/ci.yml` (one step in `lab`), `lab/tests/test_ci_gate_tooling.py` (append),
  `openbinding-gateway/.importlinter`, `openbinding-gateway/pyproject.toml`, `openbinding-gateway/uv.lock`,
  `frontend/package.json`, `frontend/pnpm-lock.yaml`, `frontend/eslint.config.js`. Read-only: `frontend/Dockerfile`,
  `frontend/Dockerfile.e2e`, `openbinding-gateway/Dockerfile`, `lab/tests/test_lab_compose.py`.
- Requirements: `import-linter-contract`, `import-linter-dev-only`, `import-linter-report-only`, `eslint-boundaries`,
  `frontend-images` (design.md §4–§5).
- [ ] 2.1 Tests: `test_importlinter_contract_mirrors_layers`, `test_import_linter_is_locked_dev_only`,
  `test_import_linter_step_is_report_only`, `test_eslint_boundaries_warns_page_to_page`,
  `test_frontend_images_get_plugin_only_by_frozen_install`. All red on the base.
- [ ] 2.2 `.importlinter`, the `lint` dependency group and the `lab` step of design.md §4.
- [ ] 2.3 The devDependency and the `eslint.config.js` block of design.md §5. If the node resolver needs a package
  that is not already locked, stop and report it (a new dependency needs an exact pin and a decision).
- [ ] 2.4 The PR body states that the lab e2e image (`frontend/Dockerfile.e2e`) and the frontend `dev`/`build` stages
  now install `eslint-plugin-boundaries`, and gives the first counts of broken contracts and of boundaries warnings.
- `-k`: `test_importlinter_contract_mirrors_layers or test_import_linter_is_locked_dev_only or test_import_linter_step_is_report_only or test_eslint_boundaries_warns_page_to_page or test_frontend_images_get_plugin_only_by_frozen_install`
- Checks, in order (the two lock updates need the package index and are registered by the lead):
  1. red_before with the argv above.
  2. `["bash","-c","cd openbinding-gateway && uv add --group lint 'import-linter==2.15'"]`
  3. `["bash","-c","cd frontend && pnpm add --save-dev --save-exact eslint-plugin-boundaries@7.3.0"]`
  4. green with the argv above; the full lab suite (memory, users and image anchors stay green).
  5. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test --group lint lint-imports --config .importlinter > /tmp/lint-imports.txt 2>&1; echo \"lint-imports exit $?\"; cat /tmp/lint-imports.txt"]`:
     report-only, so the evidence is the recorded exit code and count, not exit 0.
  6. `["bash","-c","cd frontend && pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build"]`: no ESLint
     error; the warning count goes into the PR.
  7. Probe that the rule fires: `["bash","-c","cd frontend && printf \"import '../Account/Account'\\nexport {}\\n\" | pnpm exec eslint --stdin --stdin-filename src/pages/About/Probe.tsx > /tmp/boundaries-probe.txt; grep -c 'boundaries/' /tmp/boundaries-probe.txt"]`
     (exits non-zero when no boundaries warning is printed).

## S3. Job `bim-toolchain` (~35 non-test lines + ~60 test lines; turn budget 30)

- Owned: `.github/workflows/ci.yml` (new job), `lab/tests/test_ci_gate_tooling.py` (append). Read-only:
  `bim-toolchain/**`, `.agentic/project.yaml` G5 `bim-toolchain`.
- Requirements: `bim-toolchain-tests`, `bim-toolchain-goldens` (design.md §6).
- [ ] 3.1 Tests: `test_bim_toolchain_job_runs_package_tests`, `test_bim_toolchain_job_checks_goldens`. Both red on the base.
- [ ] 3.2 `ci.yml`: job `bim-toolchain` as in design.md §6, no `continue-on-error`.
- `-k`: `test_bim_toolchain_job_runs_package_tests or test_bim_toolchain_job_checks_goldens`
- Checks: red_before and green with the argv above; the full lab suite; and the real commands, which need the five
  OMG XSDs present or omg.org reachable:
  `["bash","-c","cd openbinding-gateway && uv sync --locked --extra test && cd ../bim-toolchain && export PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src && ../openbinding-gateway/.venv/bin/python -m pytest -p no:cacheprovider --rootdir=. -q packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests > /tmp/bim-toolchain-tests.txt 2>&1; status=$?; tail -n 40 /tmp/bim-toolchain-tests.txt; exit $status"]`;
  `["bash","-c","cd bim-toolchain && PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src ../openbinding-gateway/.venv/bin/python tools/baseline_core.py --check"]`.
  If either fails on the base (an import the gateway environment lacks, or the 83/82 corpus count of design.md §9),
  checkpoint and report; do not make the job report-only.

## S4. Acceptance runners (~110 non-test lines + ~70 test lines; one PR, two tasks)

Requirements: `api-runner`, `ui-runner`, `acceptance-docs` (design.md §7). No acceptance test is written.

### S4a. Implementer (turn budget 35)
- Owned: `.github/workflows/ci.yml` (one step in `lab`, one in `frontend`), `lab/tests/test_ci_gate_tooling.py`
  (append), `frontend/playwright.acceptance.config.ts`, `frontend/src/test/e2eSpecs.test.ts` (add the config to
  `configs`), `TESTING.md` (§2).
- [ ] 4.1 Tests: `test_api_runner_passes_empty_and_runs_in_lab` (runs `sys.executable -m pytest -c
  acceptance/api/pytest.ini acceptance/api -q -p no:cacheprovider -k zz_selects_nothing` from the root through
  `subprocess`, `check=False`, and asserts exit 0; with all tests deselected pytest reports 5, so the hook is exercised
  whether or not acceptance tests exist), `test_ui_runner_passes_empty_in_frontend_job`,
  `test_acceptance_docs_name_runners_and_writer`. All red on the base.
- [ ] 4.2 The two CI steps, the Playwright config, the `e2eSpecs.test.ts` line and `TESTING.md` §2.

### S4b. Test-designer (turn budget 20; after S4a, same PR)
- Owned: `acceptance/README.md`, `acceptance/api/pytest.ini`, `acceptance/api/conftest.py`, `acceptance/ui/.gitkeep`
  (G4 path; runners and documentation only, no test).
- [ ] 4.3 The four files of design.md §7.

- `-k`: `test_api_runner_passes_empty_and_runs_in_lab or test_ui_runner_passes_empty_in_frontend_job or test_acceptance_docs_name_runners_and_writer`
- Checks: red_before (S4a, base files) with the argv above; after S4b: green with the argv above, the full lab suite,
  `["bash","-c","cd openbinding-gateway && uv run --locked --extra test python -m pytest -c ../acceptance/api/pytest.ini ../acceptance/api -q"]`
  (exit 0, "no tests ran") and
  `["bash","-c","cd frontend && pnpm install --frozen-lockfile && pnpm test && pnpm exec playwright test --config playwright.acceptance.config.ts --pass-with-no-tests"]`.

## A. Archive (after S4, explicit archive task)
- [ ] `["openspec", "archive", "m03-gate-tooling", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.
- [ ] Follow-ups for the owner, outside this change: `gate-tooling` in the capability table of `openspec/project.md`;
  the constitution GAP lines and `todo: true`, once the gates block.

G1 for this change: `["openspec", "validate", "m03-gate-tooling", "--strict"]` (not registered for workers today).
