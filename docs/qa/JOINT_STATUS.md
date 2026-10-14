# Joint status

State of the work that spans OpenBinding, the remote SPACE/SPHERE services and
the BIM extraction. "Done" means the change exists in this tree; it does not mean
it was exercised end to end. The first section is the **current view** (2026-10-14, head `b2780381`); the table after it is the view of
2026-10-13 at SHA `5aebc7c8`, kept as history (a few rows are marked as superseded). Every figure is tied to the SHA it was
measured on; evidence of one SHA is not attributed to another.

## Current view (head `b2780381`, phase 16 closed)

Figures reported by the coordinator for the head, plus the records already in this repository for `ce7229b2`. This document did
not re-run them.

| Item | State | Evidence (SHA) |
|---|---|---|
| Worker CPU limit: a real `SIGXCPU` delivered by the kernel gives 503 `operation_timeout` | **Closed** | Bug fixed in `bim_service/_worker.py` (with a finite hard `RLIMIT_CPU` the soft limit was clamped *to* it, the kernel sent `SIGKILL` and the answer was a 500; now soft = hard - 1 s). Tested with real processes in the `bim-toolchain` suite of `ce7229b2` (functional code identical to `b2780381`, per the coordinator). See `bim-toolchain/docs/SERVICE.md` |
| Worker recycling at the real `RETIRE_ANSWERS` = 1000 | **Closed** | Real constant, real `xml/root` answers; same suite and SHA as above |
| Process mode, profile N2 (`compose.lab-process-n2.json`: 2 workers, body 2 MiB) in the real 256 MiB demo | **Deployed and probed** | Deployed on `ce7229b2`, probed with `process_probe.py` (exit 0, `ok=true`, `oom_kill` 0): [PROCESS_DEPLOYMENT.md](PROCESS_DEPLOYMENT.md), [PROCESS_PROBE.md](PROCESS_PROBE.md). The demo runs in process mode N2 with a body of 2 MiB (`GET /bim/v1/capabilities` publishes 2 MiB), and N2 is the profile in force **for now**. Smoke 9/9 at `b2780381` |
| Corpus skip of `bim-core/tests/test_boundary.py` | **Closed** | `BIM_REQUIRE_CORPUS=1`: `bim-toolchain` 1819 passed, 0 skipped, 73 xfailed at `ce7229b` ([FINAL_VALIDATION.md](FINAL_VALIDATION.md), [CORPUS_RUN.md](CORPUS_RUN.md)) |
| Real PostgreSQL 16 harness | **67 passed, 0 skipped** | `b2780381` |
| Lab smoke `smoke_lab.py` | **9/9** | `b2780381`, `DEMO_SPACE_ENABLED=false`, `plan_usage` omitted |
| Playwright live specs (desktop and mobile) | **30 passed, 0 failed, 0 skipped** ("30/0/0") | `b2780381`. `docs/qa/E2E_PLAN.md` still carries the older wording "written, NOT EXECUTED"; the run supersedes it |
| Gateway and `bim-toolchain` suites | **Exit 0** | Run on `ce7229b2`, whose functional code is identical to `b2780381` (per the coordinator): gateway 1825 passed / 10 skipped / 65 xfailed and 707 passed / 40 skipped / 1 xfailed, `bim-toolchain` 1819 passed / 0 skipped / 73 xfailed, `lab/tests` 154 passed (records in [FINAL_VALIDATION.md](FINAL_VALIDATION.md)) |
| Death of the parent in process mode (idle workers, operation in flight, clean exit) | **Tested for real** | **After `b2780381`**, in a later change that is not part of the evidence above: `bim-toolchain/packages/bim-service/tests/test_process_parent_death.py`. Idle workers left 6 to 11 ms after the parent was killed; a busy CPU-bound worker died of `SIGXCPU` at its own CPU limit (3.3 s with an operation timeout of 1 s, 6.3 s with 4 s). No code of the service was changed. Numbers and limits (not tested: a parent that is PID 1, a native call, a loaded machine): `bim-toolchain/docs/SERVICE.md` |

**Pending the human's decision (listed, not assumed):**

1. The MAJOR divergences of the IR (the strict `xfail`s for them and the `xfail` for `has()` on an interval, recorded in [FINAL_VALIDATION.md](FINAL_VALIDATION.md), are untouched).
2. Class B of the pricing (the usage counters of the development pricing; the 33 counters it keeps are an unresolved historical concession, see [REMOTE_TOOLS.md](REMOTE_TOOLS.md) and [SPHERE_PRIVACY.md](SPHERE_PRIVACY.md)).
3. N1 versus N2 for `bim-service` in the lab (N2 stays in force until the human decides; N1 was not deployed).
4. SPACE (it rejects the pricing `createdAt` with a time and has no services or contracts; the lab runs with `DEMO_SPACE_ENABLED=false`).
5. Licences, and limited Git: no licence has been chosen for the code (`NOTICE.md`), and the remote repository of `bim-toolchain` was not created (a row below). The details of the Git limitation are not recorded in this document.

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
| Docker demo (lab compose) | **Done in part** (history; the demo now runs `bim-service` in process mode N2, smoke 9/9 at `b2780381`: current view) | At SHA `5aebc7c8`: `lab_compose up` leaves 11 services healthy; `seed_lab.py` is idempotent except that a toolchain change (`irDigest`) creates a new case revision (`simple-seq:2`); `smoke_lab.py` **9/9** (24.4 s) with `DEMO_SPACE_ENABLED=false`, `plan_usage` omitted. With SPACE enabled and contracts: **not executed**. See [DEMO.md](../DEMO.md) |
| Real PostgreSQL | **Done in part** (history; 67 passed, 0 skipped at `b2780381`: current view) | PostgreSQL 16 via `lab_compose` (`compose.pgtest.json`), observed in the lab: `tests/concurrency` **58 passed, 0 skipped** in 12 s (leases, job publication, idempotency, study cancellation, sweep vs cancellation, cells, two-session smoke). The 26 compose-shape tests moved to the normal suite (`tests/test_pg_harness.py`) and are no longer skipped; the studies fixture now creates the owner's membership; each test has a 60 s watchdog. An earlier run (SHA `5aebc7c8`) gave 45 passed, 26 skipped; that gap (T1) is closed. The rest of the suite still runs on SQLite only. See [PG_HARNESS.md](PG_HARNESS.md) |
| Hardening of `bim-core` and the gateway | **Done** (fixes) | Integer-size limit (A1), ZIP bomb (A2, also in the gateway), unsafe flags refused in prod (M2), `engines:execute` on analysis pareto/cancel (M3), `result.error` redacted for VIEWER (B1), chunked payload ceiling (B2), lab nginx `X-Forwarded-For` (B7). Details and the open findings in [SECURITY_REVIEW.md](SECURITY_REVIEW.md) |
| Security review (bounded, Opus) | **Done**; findings **pending a human decision** | 2026-10-13. Open: M1, M4, M5 (rest), B3-B6, B8. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) |
| End-to-end (browser + gateway + engines + remote services) | **Pending** at this SHA (**superseded** for the Playwright live specs: 30 passed / 0 failed / 0 skipped at `b2780381`) | The recorded 2026-10-10 frontend run in [`frontend-qa/README.md`](../frontend-qa/README.md) predates these changes. At this SHA the Playwright live specs were written, **NOT EXECUTED**. The by-eye mobile/desktop check is manual and is not recorded as done; remote services with real SPACE contracts: not executed |
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
