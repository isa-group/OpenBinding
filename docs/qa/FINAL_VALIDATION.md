# Final validation

## Current view (head `31b7de6f2002fb4b5e5f0c549a3bd4a2a2818fa2`, branch `feat/openbinding-platform`, 2026-10-14)

Functional commits of this head: `80ad32d4` (data B/C1/A2), `f5acbd70` (Java engines, PostgreSQL and frontend fixes),
`ea955411` (licence per package), `59ef9749` (PostgreSQL test fix, C3, cancellation of running jobs) and `31b7de6f`
(permissions of the Java builder images). Everything below ran in the real Docker laboratory (rootless, 256 MiB for
`bim-service`) under the controller; this document did not re-run it. Each figure carries the SHA it was measured on. The
sections that follow are records of earlier SHAs and stay as history; where they say something this view settled, the
statement is **superseded** (see the list after the tables).

### Closed (measured)

| What | Result | SHA |
|---|---|---|
| PostgreSQL 16 real (`compose.pgtest.json`), `tests/concurrency tests/test_federated_engines_pg.py tests/test_duplicate_copy_purge_pg.py` ([PG_REAL_RUN.md](PG_REAL_RUN.md)) | **113 passed, 0 skipped, 0 failed**, 24.31 s. Includes 20 `test_federated_engines_pg` (the two former `xfail` now pass), 16 `test_duplicate_copy_purge_pg`, 7 `test_cancel_running_pg`. One SAWarning, not a failure (below) | `59ef9749` |
| Same, first run | 105 passed, 1 failed (`DetachedInstanceError`, a defect of the test, fixed; not of the service) | `ea955411` |
| MiniZinc real 2.6.4 (`compose.lab-engines.json`), `engine-real-tests` | **44/44 passed, 0 skipped** (real `minizinc solve` to OPTIMAL by POST/GET, `DELETE` kills `minizinc` and its backend with no zombie and frees the CPU, group kill, SIGKILL if SIGTERM is ignored, grandchild that outlives the leader, foreign/unknown id gives the same 404, 401 without token, idempotence) | `59ef9749` |
| Same, `seed` (`tools/engine_e2e.py --url http://engine:3000 --scenario all --expect optimal`) | **16 PASS, 1 NO EJECUTADO**, `engine_e2e: ok`. The one not executed: the process checks (CPU, group, zombies) in `--url` mode, because the solver is in another container (the real tests above do cover them). The result is re-evaluated with `bim_core.reevaluate` and classified `optimal` | `59ef9749` |
| Same, first run | 43/44: the test "kills a grandchild that outlives the leader" was a race of the test (the grandchild died of SIGTERM before installing its handler); fixed by waiting for CPU spent by the grandchild; 44/44 in the lab | `ea955411` then `59ef9749` |
| Java engines in Docker (`compose.lab-engines-java.json`) | `binding-core` 56 tests (25 `CanonicalEvaluatorConformanceTest` + 17 `EngineJobsTest` + 14 `EngineHttpTest`), 0 failures, on JDK 8 (seed, builder of `random-search`) and on JDK 21 (evolutionary); `random-search` 12 (4 + 8), `many-heuristic` 11 (3 + 8), `multi-heuristic` 12 (3 + 9), `evolutionary-heuristics` 13 (5 + 8); all 0 Failures/Errors/Skipped | `31b7de6f` |
| Same, before the fix | the services failed with `cp: Permission denied` (mode 700 of the builder's `COPY`); fixed with `RUN chmod -R a+rX /app` in the four Dockerfiles | before `31b7de6f` |
| Same JUnit in the worker (no Docker) and the Python e2e with real `java` processes (`engines/e2e`) | 104 JUnit tests; 35 passed ([ENGINES_JAVA_IR02.md](ENGINES_JAVA_IR02.md)) | worker tree |
| Remote cancellation end to end in the N1 demo (`tools/cancel_probe.py` through `lab_compose seed`, `DEMO_SEED_TOOL=cancel_probe.py`) ([ENGINE_CANCELLATION_E2E.md](ENGINE_CANCELLATION_E2E.md)) | **classification `passed`, `ok` true**, 9 checks ok, 0 findings. `minizinc-csp`, `exact-weighted`, 150 tasks x 30 candidates; `POST /v1/jobs/{id}/cancel` => 200; job `cancelled` about 1.0 s later (timeline: launched 6.5 s, running 7.6, registered 8.4, cancel-requested 8.7, job-ended 9.7, settled 9.8); `job_engine_attempts` `cancel_state=sent`, `cancel_attempts=1`; the engine reads the id as cancelled; a direct `DELETE` gives 200 `cancelled` and a second one is idempotent (200 `cancelled`) | `31b7de6f` |
| Snapshot `invalid_instance`, real diagnosis with `tools/diagnose_snapshots.py` (read only) ([SNAPSHOT_INVALID_INSTANCE.md](SNAPSHOT_INVALID_INSTANCE.md)) | Cause found: the 0.1.x package pins an exact contract (profile/dialect) that toolchain 0.2.0 no longer installs (`contract_not_installed` at `/spec/contracts` of `instance.json`). The package is really invalid for 0.2.0; it is not a recompilation bug. Kept as evidence; launching it gives 422 `snapshot_not_recompilable` | `ea955411` |
| Demo N1 (`compose.lab-process.json`, 1 process, body 6291456, 256 MiB): `seed_lab` | idempotent | `31b7de6f` |
| Demo N1: `smoke_lab` | **9/9** (`proxy_and_spa`, `login`, `owner_job`, `idempotency`, `authorization` 24 checks, `concurrency_limit`, `cors`, `body_limit`, `login_throttle`); `plan_usage` skipped (SPACE on hold) | `31b7de6f` |
| Demo N1: Playwright desktop + mobile | **30 passed, 0 failed, 0 skipped**, 0 visual problems (`E2E_SUMMARY passed=30`; screenshots reviewed, 131 images including `screenshots/_summary.png`) | `31b7de6f` |
| Demo N1: `process_probe.py` with the five N1 `--expect` and `--timeout-probe --expect-operation-timeout 3` ([PROCESS_PROBE.md](PROCESS_PROBE.md)) | **exit 0, `ok` true, 6 steps**: `capabilities` 16 checks (fit: required 265918873 of 268435456 B, headroom 2516583 B); `valid_operations` 84; `hostile_small` 55; `large_bodies` 13 (6291456 B body => 200 in 30.9 ms; two retained bodies 200 and 200); `saturation` 9 (8 clients: 3 x 200, 5 x 503 `service_busy`); `healthz_under_load` 11 (116 samples, 116 x 200; p50 1.5 ms, p95 1.8 ms, max 2.0 ms); `timeout_replacement` 12 (503 `operation_timeout` at 3.467 s; 35 `/healthz` samples all 200, max 2.4 ms; the next normal request 1.9 ms) | `31b7de6f` |
| Memory of `bim-service` with the demo idle | cgroup 88-95 MiB of 256 MiB, `oom_kill` 0; parent RSS 59.7 MB (peak 59.7), child 53.9 MB (peak 56.8-57.1) | `31b7de6f` |
| Frontend, full vitest (tree of F1: base `80ad32d4` + F1) | **177 test files passed (177); 2471 tests passed (2471)**; `tsc -b` and eslint ok | tree of F1 |
| `bim-toolchain` suite (tree of `ea955411`) | **2294 passed, 0 failed, 0 skipped, 3 xfailed** | `ea955411` |
| `verify_release` (two builds in different directories, `SOURCE_DATE_EPOCH=1767225600`) | artifacts identical bit for bit (hashes below) | `ea955411` |
| Gateway as consumer of the toolchain | 402 passed, 2 skipped (`BIM_BASELINE_FULL`, slow; not build or corpus) | `ea955411` |

Notes on the rows above:

* The SAWarning in PostgreSQL: `DELETE statement on table 'v1_instance_snapshots' expected to delete 1 row(s); 0 were matched`
  in `test_two_replicas_regenerating_the_same_snapshot`. Benign: the second replica does not find the row the first already
  deleted. It is a warning, not a failure.
* The first `process_probe.py` run, without the N1 flags, gave `ok` false because it expected the N2 values. That was a wrong use
  of the probe, not a service failure; the run above has the five N1 `--expect`.
* Before G2 the gateway did **not** propagate the cancellation of a `running` job to the solver (only after `solve_remote`
  returned). G2 added `CancelWatch` in `services/execution.py` (it watches the `cancellation_requested` flag between polls,
  claims the attempt, sends `DELETE`, and writes `CANCELLED` only on the engine's confirmation; with no confirmation in time the
  job is `FAILED` `engine_timeout` and the cancellation stays pending for the reconciler) and fixed the reconciler for bundled
  registrations. `REMOTE_CANCEL_WATCH_INTERVAL_S=1` and `REMOTE_CANCEL_CONFIRM_TIMEOUT_S=30` are read in `execution.py`, not in
  `Settings`.
* Operations: jobs queued before a deployment pin the previous version of the bundled registration and fail with
  `registration_changed`; drain the queue or let them finish before rolling out.
* The Java engines are **synchronous by default**; remote cancellation is opt-in with `ENGINE_JOB_MODE=async`, and the bundled
  registrations declare the capability only for `minizinc-csp` (`BUILTIN_CANCELLATION`) or for the names in
  `ENGINE_CANCELLATION_BUILTIN`. In the lab the Java engines were **not** run in async mode behind the gateway: **NO EJECUTADO**
  end to end. Their cancellation is proven at engine level (JUnit with thread and CPU readings) and by the local Python e2e.

### Release artifacts of `bim-toolchain` (`ea955411`)

| File | sha256 | Bytes |
|---|---|---|
| `bim_core-0.2.0-py3-none-any.whl` | `80dd58ba38d71cea28ae3ba483609298882feb9c23c61a400ac05c56b44311f0` | 132869 |
| `bim_core-0.2.0.tar.gz` | `690da1fb26e1bc3ceb5befbc5407cd7fc6c6c4d4c5ae7e726a3752756e8512c8` | 114061 |
| `bim_service-0.2.0-py3-none-any.whl` | `45ca51bdda278090244c1ba08f9cbdd676582ab3f7cf6c5c07b39dd5f006a2e9` | 61046 |
| `bim_service-0.2.0.tar.gz` | `e767c77f105909a24f88a745328571cbc0e0a44c395456e23cf2de71ec4177c4` | 52687 |
| `bim_client-0.2.0-py3-none-any.whl` | `5cff0e6cbc0a134e7f726444240e1046741f411b1a0b362def669cb7065ea4c3` | 26817 |
| `bim_client-0.2.0.tar.gz` | `725621fc7c21fdc94bc41444c2e6bc2d3242c39483c6fe0b9bb349c9fb4dba5e` | 21509 |

`compilerDigest` `sha256-ccc55839be2e311d7adfe3c44ee0a70a6e7b19acb28b786f8dee6a8da593418e`, equal in wheel, sdist, installation,
service and tree. `toolchain.json` sha256 `5af837d8d7a3c9234a70bd86a127eaf0e735507f195c8b7eb7439011e2d67aa4`. Baseline: 82
packages, 0 differences. The `toolchain` metadata of the normalized golden was regenerated (`749170b5...` to `ccc55839...`)
with the IR, semantic digests, evaluations and `zip_equivalence` **unchanged** (comparison in
`bim-toolchain/golden/toolchain_metadata_comparison.json`); a coherence test fails if they diverge. The Docker image of
`bim-service` built in the lab with the per-package `LICENSE` (Dockerfile adjusted). Licence CC-BY-4.0 (holder `javiercavlop`,
own material; the OMG XSDs and third parties are **not** covered), SPDX in `licenses.json` and `pyproject.toml`. The five OMG
XSDs carry no copyright notice in their bytes and the permission to redistribute them is **not demonstrated**
(`bim-toolchain/docs/OMG_XSD_RIGHTS.md`); the export leaves them blocked by default.

### Open: not executed, or pending

| Item | State |
|---|---|
| SPACE | On hold; zero calls were made |
| Class B counters against a real SPACE | **NO EJECUTADO** |
| Push, GitHub, real CI, Python 3.12, macOS of the export | **NO EJECUTADO** (nothing was pushed or published) |
| Java engines in async mode behind the gateway | **NO EJECUTADO** end to end (see the notes) |
| `export_repo.py` sequence on the Mac | **NO EJECUTADO** (steps in `bim-toolchain/docs/DELIVERY.md`) |
| `gh auth` of the operator | Pending |
| Holder's decision on the OMG XSDs | Pending |
| 2 stale snapshots in `blocked` (`snapshot_conflict`) of other owners | Residual risk, documented, **not decided** whether to delete them ([SNAPSHOT_INVALID_INSTANCE.md](SNAPSHOT_INVALID_INSTANCE.md)) |
| `Settings` does not include `REMOTE_CANCEL_*` | Open finding |

### Superseded by this view

* "PostgreSQL 16 real: 70 passed" (`bef53047`) is history; the current figure is 113 passed at `59ef9749` with the phase-17 and
  cancellation modules.
* "The real timeout and replacement with one slot in the N1 container is **PENDING**" (status of `c2d46151` below) is closed:
  `timeout_replacement` 12 checks, 503 `operation_timeout` at 3.467 s, at `31b7de6f`.
* "The cause of the `invalid_instance` snapshot is unknown" is closed: `contract_not_installed`, see above.
* "No engine implements `DELETE`" (older engine documents) no longer holds: `minizinc-csp` always implements it and the Java
  engines implement it in async mode; the gateway sends it for running jobs since G2.
* The frontend figure "2467 tests (output truncated)" is replaced by the measured 2471 passed in 177 files.
* "No licence chosen" is replaced by CC-BY-4.0 for the own material; the OMG XSDs remain undecided.

## Status of 2026-10-14 (head `c2d46151`; the sections below are records of earlier SHAs)

The human decided on 2026-10-14: normalized IR (MAJOR, version 0.2.0, no compatibility with the old order); measurable usage
limits yes, credits and CU no; class B counters not retired for being counters (SPACE is their native source, on hold); profile
N1 in the demo. Figures reported by the coordinator, each tied to its SHA; they were not re-run by this document.

| What | Result | SHA |
|---|---|---|
| PostgreSQL 16 real | 70 passed, 0 skipped (67 + 3 plan-concurrency); migrations up to `b6c7d8e9f0a1` | `bef53047` (functional code before M) |
| `bim-toolchain` core + service + client | 2153 passed, 0 failed, 22 skipped (wheels not built), 3 xfailed (B8 thread) | `bef53047` / the workers' trees |
| Gateway `a`-`m` | 1906-1920 passed, 10 skipped | `bef53047` / the workers' trees |
| Gateway `n`-`z` + concurrency | 875 passed, 43 skipped (PostgreSQL), 1 xfailed | `bef53047` / the workers' trees |
| Frontend | 2467 tests (figure of worker L, output truncated); build 9.04 s | the worker's tree |
| Smoke N1 | 9/9 in 6.0 s (a first run on `bef53047` gave 6/9, `422 contract_not_installed`) | `c2d46151` |
| Playwright N1 | 30 passed, 0 failed, 0 skipped (a first run on `bef53047` gave 29 passed / 1 failed) | `c2d46151` |
| `process_probe.py` N1, no timeout step | exit 0, `ok=true` ([PROCESS_PROBE.md](PROCESS_PROBE.md)) | `c2d46151` |

**Superseded by this phase:** the "64 + 4 IR MAJOR xfails and the `has()` xfail are untouched" statements in the records below
(the IR was normalized in `f98a7a1e`: 82 of 82 packages equal, the 64 + 4 `xfail` removed, `has()` fixed; see
[IR_NORMALIZATION.md](IR_NORMALIZATION.md)), and "process mode N2 is the demo profile" (N1 is, see
[PROCESS_DEPLOYMENT.md](PROCESS_DEPLOYMENT.md)). The parent-death case is tested with real processes (`0fc19a83`, no bug found).

**Still open:** SPACE (on hold, never exercised); class B counters and `federatedEngines` not measured against a real SPACE
(synthetic source only); rights and licences (code, schemas, OMG XSD); the limited Git credential for the private repository
`javiercavlop/bim-toolchain`, and publication; the real timeout and replacement with one slot in the N1 container is
**PENDING** (no evidence yet; `compose.lab-process-n1-probe.json`, task P).

## Record of `ce7229b` (process mode N2, SIGXCPU, recycling, corpus; history)

Cabeza validada: `ce7229b` (the base commit `ce7229b`, short SHA taken from the git status of the start of this task; this
worker has no shell, so `git rev-parse HEAD` could not be run and the full SHA is not recorded. The working tree had only the
documentation changes of this task, which are not code, tests or manifests).

Each check was run by this task through `qa_run`, by index, once, with no retries. The registered indexes of this contract
are 0 to 5 (index 4 is the lab test suite, there is no frontend check in this contract).

| Index | What | Exit | Result | Time |
| --- | --- | --- | --- | --- |
| 0 | `uv sync`, ruff, OpenAPI drift | 0 | `All checks passed!`; `The OpenAPI snapshot matches the code.` | not shown |
| 1 | gateway `tests/test_[a-m]*.py` | 0 | 1825 passed, 10 skipped, 65 xfailed, 0 failed, 10 warnings | 236.56 s |
| 2 | gateway `tests/test_[n-z]*.py` + `tests/concurrency` | 0 | 707 passed, 40 skipped, 1 xfailed, 0 failed, 2 warnings | 105.51 s |
| 3 | bim-toolchain (`bim-core`, `bim-service`, `bim-client`), `BIM_REQUIRE_CORPUS=1` | 0 | 1819 passed, **0 skipped**, 73 xfailed, 0 failed, 1 warning | 434.35 s |
| 4 | `lab/tests` | 0 | 154 passed, 0 skipped, 0 failed | 0.29 s |
| 5 | changelog, `git diff --check` | 0 | `changelog-ok` | not shown |

* Skips in 1 and 2 are the same as in the earlier records below: 3 PostgreSQL row-lock, 2 slow baseline (`BIM_BASELINE_FULL=1`),
  5 legacy generator jar not built (check 1); 40 `requires PostgreSQL: set TEST_DATABASE_URL` (check 2). Check 3 has no skip: the
  `test_boundary.py` skip is closed (see [CORPUS_RUN.md](CORPUS_RUN.md)).
* xfails in 3: 73 (the 69 of `bim-core` plus 4 in `bim-service`, all strict and untouched: IR MAJOR divergence, the `unordered-*`
  cases, `has()` on an interval, and the thread-mode ones). I did not see the split in this run's output.
* Check 2 shows 707 passed against 689 in the earlier record: the count changed since the previous SHA; I did not investigate why.
* Measurements printed by check 3 (informational) include the real-kernel tests: SIGXCPU delivered with soft 4 s (worker died at
  4.00 s of CPU, 3.79 s after admission; 503 `operation_timeout`; `/healthz` 156 probes all 200, slowest 13 ms; one replacement; 15
  descriptors before and after), and the recycling: 1000 answers through one worker in 0.66 s, replaced after the 1000th; 2200 answers
  through 2 slots in 1.56 s with 2 workers retired after exactly 1000 answers each. Fit rule for the lab thread settings: 655260057
  bytes against 268435456, fits False; largest body that fits: 2 MiB (N=2) and 6 MiB (N=1).
* Not run by this task and recorded by the coordinator (not verified here): `bim-core` 1222 passed / 0 skipped / 69 xfailed
  after the corpus change; `bim-service` + `bim-client` 597 passed / 0 skipped / 4 xfailed; the demo in process mode N2
  (fit rule validated at start, smoke 9/9, probe exit 0 with `ok=true`, `oom_kill` 0; see
  [PROCESS_DEPLOYMENT.md](PROCESS_DEPLOYMENT.md) and [PROCESS_PROBE.md](PROCESS_PROBE.md)). The frontend, Playwright and the
  PostgreSQL 16 harness were not re-run in this contract; their records below are of earlier SHAs.

### Parent memory in the N2 demo

`lab_compose metrics` reports bytes (`rss_bytes`); the figures in MB are decimal. The parent (PID 1 of `bim-service`) was
61.6 MB before the load and 67.6 MB (67604480 B = 64.5 MiB; peak 68.9 MB) after the probe, above the conservative `P` of
62914560 B (60 MiB) of the fit rule. With P = 67604480 B the rule requires 266414489 B against 268435456 B (headroom about
2.0 MB): it still fits.

### What is closed and what is not

* Closed: the worker CPU-limit bug (SIGKILL/500 became SIGXCPU/503); SIGXCPU and the 1000-answer recycling tested with real
  processes; the `test_boundary.py` skip; process mode N2 deployed and probed in the 256 MiB demo.
* The parent-died case was **not tested at `ce7229b`** (the sentence of this record). It was tested afterwards, in a later change
  (after `b2780381`; results and limits in `bim-toolchain/docs/SERVICE.md`, "When the parent dies, tested for real"): idle workers
  left 6 to 11 ms after the parent was killed, a busy CPU-bound worker died of `SIGXCPU` at its own CPU limit, and no code of the
  service was changed. That evidence belongs to that later change and is not attributed to `ce7229b` or `b2780381`.
* Not closed (at `ce7229b`; the IR `xfail` items are superseded, see the status above): natural SIGXCPU with equal budgets needs native multithreaded code without the GIL
  (not built); the kernel counts CPU in whole seconds; thread mode keeps 3 strict `xfail`; the 64 + 4 IR MAJOR xfails and the `has()`
  xfail are untouched; not reached by the probe in the demo: 413 `pending_body_too_large`, 413 `memory_budget_exceeded`, a worker
  killed from outside, a client disconnect.

## Earlier record (d239de47)

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
