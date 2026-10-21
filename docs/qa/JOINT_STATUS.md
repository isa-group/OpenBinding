# Joint status

State of the work that spans OpenBinding, the remote SPACE/SPHERE services and
the BIM extraction. "Done" means the change exists in this tree; it does not mean
it was exercised end to end. The first section is the **current view** (2026-10-14, head `31b7de6f`); after it come the view of
`c2d46151` (earlier the same day), the view of `b2780381` (phase 16) and the view of 2026-10-13 at SHA `5aebc7c8`, all kept as
history (rows and notes in them that were later settled are marked as superseded). Every figure is tied to the SHA it was
measured on; evidence of one SHA is not attributed to another.

## Current view (head `31b7de6f2002fb4b5e5f0c549a3bd4a2a2818fa2`, branch `feat/openbinding-platform`, 2026-10-14)

Figures reported by the controller from the real Docker laboratory (rootless, 256 MiB for `bim-service`). This document did not
re-run them; the only thing run for this change is the registered docs check. Full detail and the artifact hashes:
[FINAL_VALIDATION.md](FINAL_VALIDATION.md).

Functional commits: `80ad32d4` (data B/C1/A2), `f5acbd70` (Java engines, PostgreSQL and frontend fixes), `ea955411` (licence
per package), `59ef9749` (PostgreSQL test fix, C3, cancellation of running jobs), `31b7de6f` (permissions of the Java builder
images).

### Matrix: closed and pending

| Area | State | Evidence (SHA) |
|---|---|---|
| PostgreSQL 16 real | **Closed**: 113 passed, 0 skipped, 0 failed in 24.31 s (20 federated engines, whose two former `xfail` now pass; 16 duplicate copy and purge; 7 `test_cancel_running_pg`; the rest `tests/concurrency`). One benign SAWarning. [PG_REAL_RUN.md](PG_REAL_RUN.md) | `59ef9749` (first run 105 passed, 1 failed, a test defect, at `ea955411`) |
| MiniZinc real 2.6.4 | **Closed**: `engine-real-tests` 44/44, 0 skipped; `seed` 16 PASS, 1 NO EJECUTADO (process checks in `--url` mode, covered by the real tests), `engine_e2e: ok`, classified `optimal` after `bim_core.reevaluate` | `59ef9749` (43/44 at `ea955411`: a race of one test, fixed) |
| Java engines in Docker | **Closed** as JUnit: `binding-core` 56, `random-search` 12, `many-heuristic` 11, `multi-heuristic` 12, `evolutionary-heuristics` 13; 0 Failures/Errors/Skipped on JDK 8 and JDK 21. Worker without Docker: 104 JUnit, Python e2e with real `java` 35 passed. [ENGINES_JAVA_IR02.md](ENGINES_JAVA_IR02.md) | `31b7de6f` (before: `cp: Permission denied`, fixed with `chmod -R a+rX /app`) |
| Java engines in async mode behind the gateway | **NO EJECUTADO** end to end; cancellation proven at engine level and by local e2e. Default is synchronous; opt-in `ENGINE_JOB_MODE=async` | none |
| Remote cancellation end to end (N1 demo) | **Closed**: `cancel_probe.py` `passed`, 9 checks ok, 0 findings; job `cancelled` about 1.0 s after `POST /v1/jobs/{id}/cancel`; `cancel_state=sent`. [ENGINE_CANCELLATION_E2E.md](ENGINE_CANCELLATION_E2E.md) | `31b7de6f` |
| Snapshot `invalid_instance` | **Cause found**: the 0.1.x package pins an exact contract the 0.2.0 toolchain no longer installs (`contract_not_installed`). Kept as evidence, 422 `snapshot_not_recompilable`. [SNAPSHOT_INVALID_INSTANCE.md](SNAPSHOT_INVALID_INSTANCE.md) | `ea955411` |
| 2 stale snapshots of other owners | **Open (residual risk)**: status `blocked` (`snapshot_conflict`); a copy used by 4 jobs holds their identity and cannot be deleted. Not decided to delete | `ea955411` |
| Demo N1: seed, smoke, Playwright | **Closed**: seed idempotent; smoke 9/9 (`plan_usage` skipped, SPACE on hold); Playwright 30 passed, 0 failed, 0 skipped, 0 visual problems | `31b7de6f` |
| Demo N1: real timeout and replacement | **Closed** (was PENDING): `process_probe.py` exit 0, `ok` true, 6 steps; 503 `operation_timeout` at 3.467 s, `/healthz` 35 samples all 200 | `31b7de6f` |
| Memory of `bim-service` (N1, idle) | cgroup 88-95 MiB of 256 MiB, `oom_kill` 0; fit margin 2516583 B (tight) | `31b7de6f` |
| Frontend | **Closed**: vitest 177 files, 2471 tests passed; `tsc -b`, eslint ok | tree of F1 (base `80ad32d4`) |
| `bim-toolchain` | **Closed**: 2294 passed, 0 failed, 0 skipped, 3 xfailed; `verify_release` identical bit for bit; baseline 82 packages, 0 differences; gateway consumer 402 passed, 2 skipped | `ea955411` |
| Licence | CC-BY-4.0 (holder `javiercavlop`, own material; OMG XSD and third parties not covered). The 5 OMG XSDs: redistribution **not demonstrated**, export blocks them by default; holder's decision pending | `ea955411` |
| SPACE | On hold, zero calls | none |
| Class B counters against a real SPACE | **NO EJECUTADO** | none |
| Push, GitHub, real CI, Python 3.12, macOS of the export, `export_repo.py` on the Mac, `gh auth` of the operator | **NO EJECUTADO / pending**; nothing was pushed | none |
| `Settings` and `REMOTE_CANCEL_*` | **Open**: `REMOTE_CANCEL_WATCH_INTERVAL_S` and `REMOTE_CANCEL_CONFIRM_TIMEOUT_S` are read in `services/execution.py`, not in `Settings` | `59ef9749` |

Operational note: jobs queued before a deployment pin the previous version of the bundled registration and fail with
`registration_changed`; drain the queue or let them finish.

The earlier statements "no engine implements `DELETE`", "PostgreSQL tests not executed", "`invalid_instance` cause unknown",
"N1 timeout PENDING" and "no licence chosen" in the views below are **superseded** by this view.

## View of `c2d46151` (history, 2026-10-14; superseded where marked)

Figures reported by the coordinator for this phase. This document did not re-run them.

### Human decisions of 2026-10-14 (resolved; they are no longer pending)

| Decision | Resolution | Where |
|---|---|---|
| Normalized IR | **Yes, MAJOR, no compatibility with the old order.** `bim-core`, `bim-service` and `bim-client` go from 0.1.0 to **0.2.0** | [IR_NORMALIZATION.md](IR_NORMALIZATION.md) |
| Measurable usage limits | **Yes**: number of jobs, tasks and studies, time, concurrency and complexity of the binding space. **Credits and CU: no** (still out) | [USAGE_LIMITS.md](USAGE_LIMITS.md), [USAGE_LIMITS_MATRIX.md](USAGE_LIMITS_MATRIX.md) |
| Class B counters | **Not retired just for being counters.** SPACE is their native source; it is on hold, so zero calls are made and they are not applied | [USAGE_LIMITS.md](USAGE_LIMITS.md), [REMOTE_TOOLS.md](REMOTE_TOOLS.md) |
| Profile of `bim-service` in the demo | **N1** (`compose.lab-process.json`: 1 process, body up to 6 MiB, the 256 MiB container intact). N2 stays as an alternative and as history | [PROCESS_DEPLOYMENT.md](PROCESS_DEPLOYMENT.md), [DEMO.md](../DEMO.md) |

### What was integrated in this phase

| Task | Commit | Content |
|---|---|---|
| H | `0fc19a83` | Death of the parent in process mode, tested with real processes. No bug found; no service code changed |
| J | `e979f12b` | Measurable usage limits |
| L | `e1090c22` | Plan concurrency, class B port (`UsageCounterSource`), frontend UX |
| K / K2 / K3 | `f98a7a1e` | IR normalization: 82 of 82 packages equal across directory, ZIP and permutations; the 64 + 4 strict `xfail` were removed; `has()` on an interval fixed; cardinality above 4300 digits handled in blocks; `compilerDigest` `sha256-e2f269aa…` to `sha256-ccc55839…` |
| M | `9bbc189f` | IR cut-over: explicit recompilation of snapshots and an idempotent seed; stable error `422 contract_not_installed` |

### Verifications, each tied to its SHA

| Item | State | Evidence (SHA) |
|---|---|---|
| Real PostgreSQL 16 | **70 passed, 0 skipped** (67 + 3 plan-concurrency tests); migrations up to `b6c7d8e9f0a1` | `bef53047` (functional code before M) |
| Seed in the N1 profile | Idempotent; created the revision `simple-seq:2`; **one old snapshot could not be recompiled** (`invalid_instance`, reported in `recompileFailed`) | `c2d46151` |
| Lab smoke `smoke_lab.py`, N1 | **9/9** in 6.0 s | `c2d46151` |
| Playwright live specs, N1 | **30 passed, 0 failed, 0 skipped** (summary 2026-10-14T13:41:20Z) | `c2d46151` |
| `process_probe.py` in N1 (without the timeout step) | **Exit 0, `ok=true`**: details in [PROCESS_PROBE.md](PROCESS_PROBE.md) | `c2d46151` |
| First smoke and Playwright in N1 | **Failed** (smoke 6/9 with `422 contract_not_installed`; Playwright 29 passed, 1 failed) because the seeded snapshots carried compiler 0.1.0 after the IR cut-over; fixed by M and re-verified | `bef53047` (failure), `c2d46151` (re-verified) |
| Suites of the workers' trees | `bim-toolchain` core + service + client: 2153 passed, 0 failed, 22 skipped (wheels not built), 3 xfailed (B8 thread). Gateway `a`-`m`: 1906-1920 passed, 10 skipped. Gateway `n`-`z` + concurrency: 875 passed, 43 skipped (PostgreSQL), 1 xfailed. Frontend: 2467 tests (the figure of worker L, output truncated); build 9.04 s | `bef53047` / the workers' trees (not one single SHA) |

### Still open (honest limits)

1. **SPACE**: on hold and never exercised for this work. It rejects the pricing `createdAt` with a time and has no services or
   contracts; the lab runs with `DEMO_SPACE_ENABLED=false`. Native SPACE counters and limits are **not measured** against a real SPACE.
2. **Class B counters and `federatedEngines`**: not measured against a real SPACE. The `UsageCounterSource` port only has a
   synthetic source, so they are not applied.
3. **Rights and licences** (code, schemas, OMG XSD): no licence chosen (`NOTICE.md`). (**Superseded:** CC-BY-4.0 for the own
   material; the OMG XSD decision stays open, see the current view.)
4. **Limited Git credential** for the private repository `javiercavlop/bim-toolchain`, and **publication**: pending outside this
   tree; nothing has been pushed or published.
5. **Real timeout and replacement with one slot in the N1 container: PENDING, no evidence yet.** (**Superseded:** measured at
   `31b7de6f`, see the current view.) Only N2 (probe at `ce7229b2`) and tests with real processes exercised it then.
6. One old snapshot does not recompile under the new IR (`invalid_instance`), see the seed row above. (**Superseded:** the
   cause is known, see the current view.)
7. The by-eye mobile/desktop check stays manual, and the lab with SPACE enabled was not executed.
8. In N1 the fit rule with conservative figures leaves little room: required 265918873 B of 268435456 B, headroom 2516583 B
   (**tight**). Details in [PROCESS_DEPLOYMENT.md](PROCESS_DEPLOYMENT.md).

## View of `b2780381` (phase 16, history; superseded where marked)

Figures reported by the coordinator for that head, plus the records already in this repository for `ce7229b2`. They were not
re-run by this document. N2 was the profile in force then; the current profile is N1 (see above).

| Item | State | Evidence (SHA) |
|---|---|---|
| Worker CPU limit: a real `SIGXCPU` delivered by the kernel gives 503 `operation_timeout` | **Closed** | Bug fixed in `bim_service/_worker.py` (with a finite hard `RLIMIT_CPU` the soft limit was clamped *to* it, the kernel sent `SIGKILL` and the answer was a 500; now soft = hard - 1 s). Tested with real processes in the `bim-toolchain` suite of `ce7229b2` (functional code identical to `b2780381`, per the coordinator). See `bim-toolchain/docs/SERVICE.md` |
| Worker recycling at the real `RETIRE_ANSWERS` = 1000 | **Closed** | Real constant, real `xml/root` answers; same suite and SHA as above |
| Process mode, profile N2 (`compose.lab-process-n2.json`: 2 workers, body 2 MiB) in the real 256 MiB demo | **Deployed and probed** | Deployed on `ce7229b2`, probed with `process_probe.py` (exit 0, `ok=true`, `oom_kill` 0): [PROCESS_DEPLOYMENT.md](PROCESS_DEPLOYMENT.md), [PROCESS_PROBE.md](PROCESS_PROBE.md). At `b2780381` the demo ran in process mode N2 with a body of 2 MiB. **Superseded:** the profile in force is now N1 (`compose.lab-process.json`), see the current view. Smoke 9/9 at `b2780381` |
| Corpus skip of `bim-core/tests/test_boundary.py` | **Closed** | `BIM_REQUIRE_CORPUS=1`: `bim-toolchain` 1819 passed, 0 skipped, 73 xfailed at `ce7229b` ([FINAL_VALIDATION.md](FINAL_VALIDATION.md), [CORPUS_RUN.md](CORPUS_RUN.md)) |
| Real PostgreSQL 16 harness | **67 passed, 0 skipped** | `b2780381` |
| Lab smoke `smoke_lab.py` | **9/9** | `b2780381`, `DEMO_SPACE_ENABLED=false`, `plan_usage` omitted |
| Playwright live specs (desktop and mobile) | **30 passed, 0 failed, 0 skipped** ("30/0/0") | `b2780381`. `docs/qa/E2E_PLAN.md` still carries the older wording "written, NOT EXECUTED"; the run supersedes it |
| Gateway and `bim-toolchain` suites | **Exit 0** | Run on `ce7229b2`, whose functional code is identical to `b2780381` (per the coordinator): gateway 1825 passed / 10 skipped / 65 xfailed and 707 passed / 40 skipped / 1 xfailed, `bim-toolchain` 1819 passed / 0 skipped / 73 xfailed, `lab/tests` 154 passed (records in [FINAL_VALIDATION.md](FINAL_VALIDATION.md)) |
| Death of the parent in process mode (idle workers, operation in flight, clean exit) | **Tested for real** | **After `b2780381`**, in a later change that is not part of the evidence above: `bim-toolchain/packages/bim-service/tests/test_process_parent_death.py`. Idle workers left 6 to 11 ms after the parent was killed; a busy CPU-bound worker died of `SIGXCPU` at its own CPU limit (3.3 s with an operation timeout of 1 s, 6.3 s with 4 s). No code of the service was changed. Numbers and limits (not tested: a parent that is PID 1, a native call, a loaded machine): `bim-toolchain/docs/SERVICE.md` |

**Historical note, superseded (the list as it stood at `b2780381`; do not read it as current instructions).** Items 1 to 3 were
decided by the human on 2026-10-14 and are resolved in the current view: (1) the IR MAJOR divergences were normalized (0.2.0);
(2) class B counters are not retired for being counters, SPACE is their native source and it is on hold; (3) the profile is N1.
Items 4 and 5 remain open and are restated in the current view ("Still open"):

1. ~~The MAJOR divergences of the IR~~ (resolved: normalized in `f98a7a1e`).
2. ~~Class B of the pricing~~ (resolved as a decision; the counters are still not measured against a real SPACE; see [REMOTE_TOOLS.md](REMOTE_TOOLS.md) and [SPHERE_PRIVACY.md](SPHERE_PRIVACY.md)).
3. ~~N1 versus N2 for `bim-service` in the lab~~ (resolved: N1).
4. SPACE (it rejects the pricing `createdAt` with a time and has no services or contracts; the lab runs with `DEMO_SPACE_ENABLED=false`). Still open.
5. Licences, and limited Git: no licence has been chosen for the code (`NOTICE.md`), and the remote repository of `bim-toolchain` was not created (a row below). The details of the Git limitation are not recorded in this document. Still open.

## View of 2026-10-13 at SHA `5aebc7c8` (history)

| Area | State | Notes |
|---|---|---|
| Consumption accounting (credits, compute units, charging) removed | **Done** | Backend, frontend and compose. `tests/test_architecture_layers.py` forbids importing a `metering` module. Leftovers are listed under Known debt in [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Automatic Engine selection removed | **Done** | No replacement; a future component is a separate, later research project and is not documented as a feature |
| Job lifecycle (`claim_job`, 60 s lease / 20 s heartbeat, one requeue, sweep, study-cell resync, reconciler) | **Done** | `openbinding_gateway/jobs/`; guarantees in [IDEMPOTENCY.md](../IDEMPOTENCY.md) |
| Technical concurrency limit | **Done** | `MAX_CONCURRENT_JOBS_PER_USER`, `429 concurrency_limit_exceeded` (`jobs/limits.py`) |
| Layer tests | **Done** | `tests/test_architecture_layers.py`; four legacy modules still import `routes` (`ALLOWED_LEGACY`) |
| `EntitlementService` (single reader of an account's plan) | **Done** | `services/entitlements.py`; the only `.caps(` call is there. The contract lifecycle still calls `get_gate()` from six modules (`GATE_LIFECYCLE_LEGACY`) |
| Extraction from `routes/v1.py` (`job_submission`, `engine_registry`, `instances`, `discovery`) | **Done** | `routes/v1.py` went from about 3.2k to 1,329 lines (ceiling `MAX_LINES` = 1400). Remaining work in [ARCHITECTURE.md](../ARCHITECTURE.md), Known debt |
| `create_app()` | **Done** | `main.py`; remaining import effects listed in [ARCHITECTURE.md](../ARCHITECTURE.md#composition-layer-create_app) |
| `repositories/organizations.py` | **Done** | Moved: listings, memberships, slug check, invitation lookup, audit events. Queries tied to authorization rules or to a handler's transaction stay in `collaboration.py`, `access/public_read.py` and `routes/organizations.py` |
| BIM boundary | **Done** | Closed with 4 endpoints in `bim-service`; only `integrations/bim*.py` import the BIM packages (`tests/test_bim_boundary.py`) |
| Frontend | **Done** | No usage counters; native links. Vitest: 173 files, 2397 tests passed at this SHA (result of a previous contract). Lint and build are run by the supervisor in checks 3 and 4: see the supervisor's report. The Playwright specs `frontend/e2e/live/*.spec.ts` were written and **NOT EXECUTED at this SHA** (**superseded**: run later, 30 passed / 0 failed / 0 skipped at `b2780381`, see the current view) |
| OpenGate (`DEMO_SPACE_ENABLED=false`) | **Done** | Limited to technical ceilings; grants no real entitlements |
| External blocker: SPACE `createdAt` | **Blocked (external)** | SPACE answers 400 to the pricing with `createdAt` `YYYY-MM-DDTHH:mm:ssZ` ("must be a string in the format yyyy-mm-dd or a valid Date object"); SPHERE accepted the same pricing (`openbinding-dev` 0.1.0, private) |
| External blocker: SPACE services | **Blocked (external)** | SPACE is healthy but has no services and no contracts, so the lab runs with `DEMO_SPACE_ENABLED=false` until the human decides |
| Documentation aligned with the above | **Done** (this change) | `README.md`, `docs/ACCOUNTS_AND_PLANS.md`, `docs/IDEMPOTENCY.md`, `docs/ARCHITECTURE.md`, `docs/BIM_CORE.md`, `docs/SPHERE_PLATFORM_INVENTORY.md`. `docs/openapi.json` was regenerated by the openapi check and matches the code |
| `bim-core`, `bim-service`, `bim-client` in `bim-toolchain/` | **Done** | Remote repository `javiercavlop/bim-toolchain` not created |
| BIM cut-over (gateway consumes the toolchain through `BimPort`) | **Done, suite green** | `integrations/bim.py`, `BIM_MODE=inproc\|http`. Gateway suite with the duplicates removed: 1757 passed, 39 skipped (PostgreSQL, generator jar, full baseline), 2 xfailed, in 151 s. `ruff` 54 findings (limit 57), single Alembic head, `dump_openapi --check` ok. The earlier "timeouts" were the suite (about 280 s) running past the limit of the check, not a hang; see the test-time note in [BIM_CORE.md](../BIM_CORE.md) |
| Removal of the superseded in-place copy | **Done** | `v1/{canonical,package,expressions,compiler,analysis}.py`, `v1/vendor/`, `packages/bim-core/`, `tests/test_bim_core_boundary.py` removed once nothing imported them. Root tools, dataset scripts and experimentation use `bim_core`; the root `.dockerignore` admits `bim-toolchain/packages/{bim-core,bim-client}` (`tests/test_docker_context.py`). `experimentation/icws/tests` (2) and `experimentation/icsoc/generator/tests` (1) fail on the data of the packages, not on imports; they are not part of any check |
| Remote private pricing (development pricing and service, private, inside the shared organizations) | **Pending** | A shared organization does not isolate credentials; the development key is high-risk |
| Gateway code left over from the pricing-release workflow (`routes/pricing.py`, `space_client/deployments.py`, renewal sweeps) | **Pending removal** | Reachability not traced |
| Docker demo (lab compose) | **Done in part** (history; superseded: the demo now runs `bim-service` in process mode N1, smoke 9/9 at `c2d46151`: current view) | At SHA `5aebc7c8`: `lab_compose up` leaves 11 services healthy; `seed_lab.py` is idempotent except that a toolchain change (`irDigest`) creates a new case revision (`simple-seq:2`); `smoke_lab.py` **9/9** (24.4 s) with `DEMO_SPACE_ENABLED=false`, `plan_usage` omitted. With SPACE enabled and contracts: **not executed**. See [DEMO.md](../DEMO.md) |
| Real PostgreSQL | **Done in part** (history; 67 passed, 0 skipped at `b2780381`: current view) | PostgreSQL 16 via `lab_compose` (`compose.pgtest.json`), observed in the lab: `tests/concurrency` **58 passed, 0 skipped** in 12 s (leases, job publication, idempotency, study cancellation, sweep vs cancellation, cells, two-session smoke). The 26 compose-shape tests moved to the normal suite (`tests/test_pg_harness.py`) and are no longer skipped; the studies fixture now creates the owner's membership; each test has a 60 s watchdog. An earlier run (SHA `5aebc7c8`) gave 45 passed, 26 skipped; that gap (T1) is closed. The rest of the suite still runs on SQLite only. See [PG_HARNESS.md](PG_HARNESS.md) |
| Hardening of `bim-core` and the gateway | **Done** (fixes) | Integer-size limit (A1), ZIP bomb (A2, also in the gateway), unsafe flags refused in prod (M2), `engines:execute` on analysis pareto/cancel (M3), `result.error` redacted for VIEWER (B1), chunked payload ceiling (B2), lab nginx `X-Forwarded-For` (B7). Details and the open findings in [SECURITY_REVIEW.md](SECURITY_REVIEW.md) |
| Security review (bounded, Opus) | **Done**; findings **pending a human decision** | 2026-10-13. Open: M1, M4, M5 (rest), B3-B6, B8. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) |
| End-to-end (browser + gateway + engines + remote services) | **Pending** at this SHA (**superseded** for the Playwright live specs: 30 passed / 0 failed / 0 skipped at `b2780381`) | The recorded 2026-10-10 frontend run (the former `docs/frontend-qa/README.md`, archived outside the repository with the QA screenshots) predates these changes. At this SHA the Playwright live specs were written, **NOT EXECUTED**. The by-eye mobile/desktop check is manual and is not recorded as done; remote services with real SPACE contracts: not executed |
| Suite results at SHA `5aebc7c8` | **Measured** | Gateway suite (`tests` + `../lab/tests`, `BIM_BASELINE_FULL=1`): 2087 passed, 38 skipped, 13 deselected, 2 xfailed in 194.73 s. `bim-toolchain` (bim-core, bim-service, bim-client, tools): 1463 passed, 23 skipped, 1 xfailed in 54.07 s; `bim-service.v1.json` is up to date. Frontend: see the Frontend row. The 1757-passed figure in the BIM cut-over row is older |

## Verificacion consolidada d908d240

Los 9 checks registrados se ejecutaron uno a uno con `qa_run` sobre la cabeza `d908d240`. Todos terminaron con exit 0; no hubo tests fallidos. Las cifras son las impresas por cada check. Los tiempos son los que reportan pytest, vitest o vite; donde no se imprimio ninguno, se indica "no medido".

| Suite | Comando (check) | Resultado | Tiempo aprox. |
|---|---|---|---|
| Gateway: sync de dependencias | check 0: `uv sync --locked --extra test` | sync-ok | no medido |
| Gateway: `tests/test_[a-m]*.py` | check 1: `uv run --locked pytest` | 1747 passed, 0 failed, 10 skipped, 65 xfailed, 11 warnings | 238.54 s (3:58) |
| Gateway: `tests/test_[n-z]*.py` + `tests/concurrency` | check 2: `uv run --locked pytest` | 592 passed, 0 failed, 31 skipped, 1 xfailed, 2 warnings | 68.27 s (1:08) |
| bim-toolchain: bim-core, bim-service, bim-client, tools | check 3: `python -m pytest` | 1574 passed, 0 failed, 23 skipped, 5 xfailed, 1 warning | 159.60 s (2:39) |
| bim-toolchain: `dump_service_openapi.py --check` | check 3 (segunda parte) | `bim-service.v1.json is up to date` | no medido |
| Frontend: instalacion | check 4: `pnpm install --frozen-lockfile` | ok (exit 0) | 1.5 s |
| Frontend: lint | check 5: `pnpm lint` (eslint) | sin hallazgos (exit 0) | no medido |
| Frontend: vitest | check 6: `pnpm test` | 175 files passed (175); 2418 tests passed (2418); 0 failed | no medido |
| Frontend: build | check 7: `pnpm build` | built (exit 0); aviso de tamano de chunk de Vite | 9.22 s |
| Higiene del arbol | check 8: `git status --porcelain \| grep ...` y `git diff --check` | sin archivos de `node_modules`, `uv.lock`, `.venv` ni `dist/` en el status; `diff-ok` | no medido |

Notas:

- Los checks 1 y 2 reparten la suite del gateway por nombre de archivo (a-m y n-z, mas `tests/concurrency`). Suma: 2339 passed, 41 skipped, 66 xfailed, 0 failed. No incluyen `../lab/tests`, a diferencia de la fila "Suite results at SHA `5aebc7c8`".
- Los skips y xfails son los que cuenta pytest; no se analizo su causa en esta verificacion.
- Playwright (`frontend/e2e/live`), PostgreSQL real y el demo Docker no forman parte de estos checks y siguen sin ejecutarse aqui.
