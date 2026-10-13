# Final validation

SHA: `d239de47fff91f424ea3b067638785d8716ccbe2`

Every check below was run through `qa_run` on this SHA with no code changes, one
at a time, in the order 0 to 5. `qa_run` returns only the tail of stdout and of
stderr; the complete logs were not readable from this worktree. This record
contains only what was shown. **All six checks exited 0** (after fixing a race
in one test, see check 3). The record of the earlier SHA is kept at the end.

## Checks run by this task

### Check 0: backend lint and OpenAPI drift

- Command: `set -euo pipefail; cd openbinding-gateway; uv sync --extra test; uv run ruff check .; uv run python tools/dump_openapi.py --check`
- Exit code: 0
- ruff: `All checks passed!`
- OpenAPI drift: `The OpenAPI snapshot matches the code.`
- uv sync installed 74 packages. The only stderr text shown besides the package list was the hardlink warning (`UV_LINK_MODE=copy` suggestion).
- Skips and xfails: none.

### Check 1: gateway tests, `tests/test_[a-m]*.py`

- Command: `set -euo pipefail; cd openbinding-gateway; uv run pytest -q -rs tests/test_[a-m]*.py`
- Exit code: 0
- Result: **1825 passed, 10 skipped, 65 xfailed, 10 warnings** in 231.95s (0:03:51).
- Skip reasons shown:
  - 3 skipped, `tests/test_artifact_library.py:188`: "Row-lock concurrency requires PostgreSQL."
  - 1 skipped, `tests/test_bim_baseline.py:171`: "slow: recompiles all 82 packages from their ZIP; run with BIM_BASELINE_FULL=1".
  - 1 skipped, `tests/test_bim_baseline.py:208`: "slow: recompiles and re-evaluates all 82 packages; run with BIM_BASELINE_FULL=1".
  - 5 skipped, `tests/test_generator_routes.py` (lines 173, 228, 295 x2, 369): "legacy BIM generator jar not built: engines/bim-generator/target/bim-generator-0.1.0-SNAPSHOT.jar (run mvn package in engines/bim-generator)".
- xfail reasons: `-rs` does not print them (65 `x` marks, no reason text).
- Warnings: Starlette deprecation warnings (`httpx` TestClient, `HTTP_422_UNPROCESSABLE_ENTITY`) and a SQLAlchemy SAWarning ("fully NULL primary key identity") in `tests/test_job_reconciler.py`.

### Check 2: gateway tests, `tests/test_[n-z]*.py` and `tests/concurrency`

- Command: `set -euo pipefail; cd openbinding-gateway; uv run pytest -q -rs tests/test_[n-z]*.py tests/concurrency`
- Exit code: 0
- Result: **689 passed, 40 skipped, 1 xfailed, 2 warnings** in 72.46s (0:01:12).
- Skip reason: all 40 skips are in `tests/concurrency/*_pg.py` and `test_two_sessions_smoke.py`: "requires PostgreSQL: set TEST_DATABASE_URL (see docs/qa/PG_HARNESS.md)". Counts per file as listed in the output:
  - `test_job_evidence_pg.py` (6)
  - `test_job_leases_pg.py` (9)
  - `test_job_publication_pg.py` (9)
  - `test_jobs_idempotency_pg.py` (1)
  - `test_remote_cancel_pg.py` (3)
  - `test_study_cancel_pg.py` (5)
  - `test_study_cells_pg.py` (3)
  - `test_sweep_vs_cancel_pg.py` (3)
  - `test_two_sessions_smoke.py` (1)
- xfail reason: not printed (1 `x`).
- Warnings: Starlette deprecations (`httpx` TestClient, `HTTP_422_UNPROCESSABLE_ENTITY`).

### Check 3: bim-toolchain tests

- Command: `set -euo pipefail; (cd openbinding-gateway && uv sync --extra test); cd bim-toolchain; PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src uv run --project ../openbinding-gateway python -m pytest -p no:cacheprovider --rootdir=. packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests -rs`
- Exit code: 0
- Result (this run, after the test fix below): **1811 passed, 1 skipped, 73 xfailed, 1 warning** in 408.89s (0:06:48).
- Test race and fix: the previous contract's run of this check failed (1 failed, 1810 passed, 1 skipped, 73 xfailed) in `test_analysis_b8_evidence.py::test_an_asynchronous_exception_stops_a_thread_only_where_the_interpreter_looks`, where `assert raise_in(thread, Stopped) == 1` returned 0 for the `json.loads` thread. That was a race in the test, not a product defect: the sender only runs after the C call is over, so the 12 MiB parse could already be finished and `PyThreadState_SetAsyncExc` returns 0 for a thread that no longer exists. The test now takes `delivered = raise_in(thread, Stopped)`, asserts `delivered in (0, 1)` and prints `delivered` (0 = the thread had finished when the sender ran, 1 = delivered); the `woke > 0.4 * parse_alone` assertion and the pure-Python `== 1` assertion are unchanged. In this run: `delivered=1` (parse alone 445 ms, sender ran after 400 ms, thread ended at 416 ms).
- Skip reason: 1 skipped, `packages/bim-core/tests/test_boundary.py:198`: "OpenBinding originals are not available (set BIM_CORPUS_ROOT)".
- xfail reasons: not printed (73 `x` marks).
- stderr: `Resolved 77 packages`, `Audited 74 packages`.
- Measurements printed by this run (informational, not pass/fail), shown in the tail:
  - GIL stall, body 13.6 MiB: `json.loads` alone 376 ms / longest stall 222 ms; `pydantic_core.from_json` 425 / 382 ms; `validate_python(EvaluateRequest)` 142 / 10 ms; `contains_non_finite` 142 / 10 ms; `json.dumps` 145 / 147 ms; `decode_model_body` 486 / 338 ms.
  - Four spinning threads, median iterations: 5 ms 19650 (100%), 1 ms 19598 (99.7%), 0.1 ms 19699 (100.2%).
  - Real evaluate of 1000 bindings, `/healthz` medians per round: 5 ms 38.5, 48.6, 53.6 ms; 1 ms 24.5, 22.4, 26.1 ms; 0.1 ms 7.0, 5.1, 8.3 ms; requests per second about 12.2 at 5 ms and about 11.2 at 0.1 ms.
  - B8 resident memory at a 32 MiB body (fresh process per row): N=1 idle 55.1 MiB, peak VmHWM 354.7 MiB (299.6 MiB above idle, 9.4x body); N=2 peak 595.1 MiB (540.1 above idle, 8.4x per request); N=4 peak 1071.1 MiB (1016.0 above idle, 7.9x per request).
  - Workers: child at READY VmRSS 51650560 bytes (49.3 MiB), VmSize 58.6 MiB, `RLIMIT_AS` 363388928; cold start to READY 267, 259, 262 ms (median 262 ms).
  - Fit rule for the laboratory (256 MiB, N=2, L=16 MiB, B=128 MiB, Q=32 MiB, P=55451648, C=51650560): 655358361 bytes against 268435456, **fits False**. Largest body limit that fits: 2 MiB with N=2 (B 16 MiB, Q 4 MiB; 244316569 bytes) and 6 MiB with N=1 (B 48 MiB, Q 12 MiB; 253483417 bytes).
  - A 33553091-byte request through a stand-in worker: 182 ms, longest 5 ms timer stall 11 ms.
  - `/evaluate` 4 clients x 6 requests: thread 13.2 req/s, latency median 304 ms, p95 456 ms; process 23.7 req/s, median 172 ms, p95 195 ms; `/healthz` median 31.2 ms (thread) against 1.1 ms (process).

### Check 4: frontend install, lint, test, build

- Command: `set -euo pipefail; cd frontend; corepack pnpm install --frozen-lockfile; corepack pnpm lint; corepack pnpm test; corepack pnpm build`
- Exit code: 0. The script uses `set -e`, so install, lint, vitest and build all succeeded.
- Build: Vite finished with `✓ built in 9.00s`. The only build warning is that some chunks are larger than 500 kB after minification (the shown tail lists `index` 552.34 kB, `BpmnModeler` 568.57 kB; `AnalysisWorkspace` 446.59 kB and `CodeEditor` 416.02 kB are below 500 kB).
- **Not recorded: vitest file and test counts, and the lint output.** The tail of stdout was build output and the tail of stderr was vitest stderr noise; the "Test Files / Tests" summary was not in what I received. I state no numbers I did not see. For the full-run figures see the controller evidence below.
- Vitest stderr noise seen, which did not fail the run:
  - React duplicate-key warning for `case-checkout-flow` in `StudyAnalytics.test.tsx`.
  - "Token payload is not set. Please call TokenService.update first." in `SpaceProviderWrapper.test.tsx`.
- Skip and xfail reasons: none visible in the received output.

### Check 5: changelog and whitespace

- Command: `set -euo pipefail; python3 tools/generate_changelog.py --check; git diff --check; echo changelog-ok`
- Exit code: 0
- Output: `changelog-ok`. The changelog check and `git diff --check` both passed.
- Skips and xfails: none.

## Other evidence recorded by the controller (not run by this task)

- PostgreSQL 16 real harness: 67 passed, 0 skipped at `d239de47` (`compose.pgtest.json`, non-root test stage, migrations up to `b6c7d8e9f0a1`). This covers the concurrency tests that are skipped in check 2 and the row-lock test skipped in check 1.
- Lab: `smoke_lab` 9/9 at `d239de47`.
- Playwright live, desktop and mobile, at `d239de47`: 30 expected, 0 unexpected, 0 skipped, 0 flaky (`report.json` stats, startTime 2026-10-13T22:01:28Z; `screenshots/_summary.png`: "30 passed, 0 failed, 0 visual problems").
- Frontend full run of the previous contract `c757ae3b` at `a96d463b` (from the complete check log): 175 test files / 2418 tests passed, duration 237.51 s, build 9.34 s.
- BIM service container metrics (`lab_compose metrics`, bim-service PID 1, container limit 268435456 bytes): idle RSS 59727872 at `d239de47`; after smoke 61648896 (peak); during Playwright 61063168; cgroup `memory.current` 53-56 MB; `oom_kill` 0.

## Earlier record (a96d463b)

SHA: `a96d463b3e1c420279ed97a334bb3956f42570fd`

This record superseded the cancelled contract 7bf297b553e74ac9, whose frontend
step failed on `corepack enable`. Every check was run through `qa_run` on that
SHA with no code changes. All six exited 0.

- Check 0 (ruff, OpenAPI drift): exit 0; `All checks passed!`; `The OpenAPI snapshot matches the code.`; uv sync installed 74 packages.
- Check 1 (`tests/test_[a-m]*.py`): exit 0; **1825 passed, 10 skipped, 65 xfailed, 10 warnings** in 236.48s. Skips: 3 PostgreSQL row-lock (`test_artifact_library.py:188`), 2 slow baseline (`BIM_BASELINE_FULL=1`), 5 legacy generator jar not built. xfail reasons not printed.
- Check 2 (`tests/test_[n-z]*.py`, `tests/concurrency`): exit 0; **689 passed, 40 skipped, 1 xfailed, 2 warnings** in 74.57s. All 40 skips "requires PostgreSQL: set TEST_DATABASE_URL" (`test_job_evidence_pg.py` 6, `test_job_leases_pg.py` 9, `test_job_publication_pg.py` 9, `test_jobs_idempotency_pg.py` 1, `test_remote_cancel_pg.py` 3, `test_study_cancel_pg.py` 5, `test_study_cells_pg.py` 3, `test_sweep_vs_cancel_pg.py` 3, `test_two_sessions_smoke.py` 1).
- Check 3 (bim-toolchain): exit 0; **1736 passed, 1 skipped, 73 xfailed, 1 warning** in 370.36s. Skip: `test_boundary.py:198` (set `BIM_CORPUS_ROOT`). Measurements printed, informational.
- Check 4 (frontend): exit 0; build `✓ built in 9.34s`; chunk-size warning only; vitest counts and lint output were not visible in the tail and were not recorded (vitest stderr noise: duplicate React key `case-checkout-flow`, "Token payload is not set"). The complete log gave 175 test files / 2418 tests passed, duration 237.51 s, for the contract `c757ae3b` at that SHA (see above).
- Check 5 (changelog, `git diff --check`): exit 0; `changelog-ok`.
- Controller evidence at that SHA: PostgreSQL 16 real harness 67 passed, 0 skipped at `7a850e84`; lab `smoke_lab` 9/9; Playwright live 30 passed, 0 failed, 0 skipped, 0 visual problems at `a96d463b` (2026-10-13T20:09:55Z).
