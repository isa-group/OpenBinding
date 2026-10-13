# Final validation

SHA: `a96d463b3e1c420279ed97a334bb3956f42570fd`

This record supersedes the cancelled contract 7bf297b553e74ac9, whose frontend
step failed on `corepack enable`. Every check below was run through `qa_run`
on this SHA with no code changes. All six exited 0.

## Checks run by this task

### Check 0: backend lint and OpenAPI drift

- Command: `set -euo pipefail; cd openbinding-gateway; uv sync --extra test; uv run ruff check .; uv run python tools/dump_openapi.py --check`
- Exit code: 0
- ruff: `All checks passed!`
- OpenAPI drift: `The OpenAPI snapshot matches the code.`
- uv sync installed 74 packages. The only stderr was a hardlink warning (`UV_LINK_MODE=copy` suggestion).
- Skips and xfails: none.

### Check 1: gateway tests, `tests/test_[a-m]*.py`

- Command: `set -euo pipefail; cd openbinding-gateway; uv run pytest -q -rs tests/test_[a-m]*.py`
- Exit code: 0
- Result: **1825 passed, 10 skipped, 65 xfailed, 10 warnings** in 236.48s.
- Skip reasons shown in the output:
  - 3 skipped, `tests/test_artifact_library.py:188`: "Row-lock concurrency requires PostgreSQL."
  - 1 skipped, `tests/test_bim_baseline.py:171`: "slow: recompiles all 82 packages from their ZIP; run with BIM_BASELINE_FULL=1".
  - 1 skipped, `tests/test_bim_baseline.py:208`: "slow: recompiles and re-evaluates all 82 packages; run with BIM_BASELINE_FULL=1".
  - 5 skipped, `tests/test_generator_routes.py` (lines 173, 228, 295 ×2, 369): "legacy BIM generator jar not built: engines/bim-generator/target/bim-generator-0.1.0-SNAPSHOT.jar (run mvn package in engines/bim-generator)".
- xfail reasons: `-rs` does not print them. The output shows 65 `x` marks and no reason text.
- Warnings: Starlette deprecation warnings (`httpx` TestClient, `HTTP_422_UNPROCESSABLE_ENTITY`) and a SQLAlchemy SAWarning ("fully NULL primary key identity") in `tests/test_job_reconciler.py`.

### Check 2: gateway tests, `tests/test_[n-z]*.py` and `tests/concurrency`

- Command: `set -euo pipefail; cd openbinding-gateway; uv run pytest -q -rs tests/test_[n-z]*.py tests/concurrency`
- Exit code: 0
- Result: **689 passed, 40 skipped, 1 xfailed, 2 warnings** in 74.57s.
- Skip reason: all 40 skips are in `tests/concurrency/*_pg.py` and `test_two_sessions_smoke.py`. The text is "requires PostgreSQL: set TEST_DATABASE_URL (see docs/qa/PG_HARNESS.md)". The files are:
  - `test_job_evidence_pg.py` (6)
  - `test_job_leases_pg.py` (9)
  - `test_job_publication_pg.py` (9)
  - `test_jobs_idempotency_pg.py` (1)
  - `test_remote_cancel_pg.py` (3)
  - `test_study_cancel_pg.py` (5)
  - `test_study_cells_pg.py` (3)
  - `test_sweep_vs_cancel_pg.py` (3)
  - `test_two_sessions_smoke.py` (1)
- xfail reason: not printed by the output (1 `x`).
- Warnings: the same Starlette deprecations as check 1.

### Check 3: bim-toolchain tests

- Command: `set -euo pipefail; (cd openbinding-gateway && uv sync --extra test); cd bim-toolchain; PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src uv run --project ../openbinding-gateway python -m pytest -p no:cacheprovider --rootdir=. packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests -rs`
- Exit code: 0
- Result: **1736 passed, 1 skipped, 73 xfailed, 1 warning** in 370.36s.
- Skip reason: 1 skipped, `packages/bim-core/tests/test_boundary.py:198`: "OpenBinding originals are not available (set BIM_CORPUS_ROOT)".
- xfail reasons: not printed by the output (73 `x` marks).
- The run also printed load and memory measurements (GIL stall, switch interval, B8 resident memory). They are informational and not pass/fail.

### Check 4: frontend install, lint, test, build

- Command: `set -euo pipefail; cd frontend; corepack pnpm install --frozen-lockfile; corepack pnpm lint; corepack pnpm test; corepack pnpm build`
- Exit code: 0. The script uses `set -e`, so install, lint, vitest and build all succeeded. `corepack` worked this time.
- Build: Vite finished with `✓ built in 9.34s`. The only build warning is that some chunks are larger than 500 kB after minification (`index`, `BpmnModeler`, `AnalysisWorkspace`).
- **Not recorded: vitest file and test counts, and the lint output.** `qa_run` returned only the tail of stdout (build output) and the tail of stderr. The "Test Files / Tests" summary was not in what I received, and I could not read the log file (`check-6c3f083bdd1d4ab1921fd3478efab3f6.json`) from this worktree. I am not stating numbers I did not see. The controller log has them.
- Vitest stderr noise seen, which did not fail the run:
  - React duplicate-key warning for `case-checkout-flow` in `StudyAnalytics.test.tsx`.
  - "Token payload is not set. Please call TokenService.update first." in `SpaceProviderWrapper.test.tsx`.
- Skip and xfail reasons: none visible in the received output.

### Check 5: changelog and whitespace

- Command: `set -euo pipefail; python3 tools/generate_changelog.py --check; git diff --check; echo changelog-ok`
- Exit code: 0
- Output: `changelog-ok`. The changelog check and `git diff --check` both passed.
- Skips and xfails: none.

## Other evidence on this SHA (recorded by the controller, not run by this task)

- PostgreSQL 16 real harness: 67 passed, 0 skipped at `7a850e84` (`compose.pgtest.json`, non-root test stage). This covers the concurrency tests that are skipped in check 2 and the row-lock test skipped in check 1.
- Lab: `smoke_lab` 9/9.
- Playwright live: 30 passed, 0 failed, 0 skipped, 0 visual problems at `a96d463b` (`report.json` stats, `screenshots/_summary.png`, 2026-10-13T20:09:55Z).
