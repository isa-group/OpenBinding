# OpenBinding lab demo (Docker)

`compose.lab.json` (repository root) starts a self-contained OpenBinding/BIM
demo on one lab host. It is reached from a Mac through an SSH tunnel; the only
thing published on the host is `127.0.0.1:18100`.

**Current status (head `31b7de6f2002fb4b5e5f0c549a3bd4a2a2818fa2`, 2026-10-14).** Figures reported by the controller from the real
Docker laboratory (rootless, 256 MiB for `bim-service`); this document did not re-run them. Functional commits: `80ad32d4`,
`f5acbd70`, `ea955411`, `59ef9749`, `31b7de6f`. The observations of `c2d46151`, `b2780381` and `5aebc7c8` follow, tied to their
SHA, as history.

Demo N1 (`compose.lab-process.json`: 1 process, body 6291456 B, 256 MiB) at `31b7de6f`:

| Item | State | Result |
|---|---|---|
| `seed_lab` | **Closed** | Idempotent |
| `smoke_lab` | **Closed** | **9/9**: `proxy_and_spa`, `login`, `owner_job`, `idempotency`, `authorization` (24 checks), `concurrency_limit`, `cors`, `body_limit`, `login_throttle`. `plan_usage` skipped (SPACE on hold) |
| Playwright desktop + mobile | **Closed** | **30 passed, 0 failed, 0 skipped**, 0 visual problems (`E2E_SUMMARY passed=30`); screenshots reviewed: 131 images including `screenshots/_summary.png` |
| `process_probe.py` N1 with the five N1 `--expect` and `--timeout-probe --expect-operation-timeout 3` | **Closed** | exit 0, `ok` true, 6 steps: `capabilities` 16 checks (fit: required 265918873 of 268435456 B, headroom 2516583 B); `valid_operations` 84; `hostile_small` 55; `large_bodies` 13 (6291456 B body => 200 in 30.9 ms; two retained bodies 200 and 200); `saturation` 9 (8 clients: 3 x 200, 5 x 503 `service_busy`); `healthz_under_load` 11 (116 samples, all 200; p50 1.5 ms, p95 1.8 ms, max 2.0 ms); `timeout_replacement` 12 (503 `operation_timeout` at 3.467 s; 35 `/healthz` samples all 200, max 2.4 ms; the next normal request 1.9 ms) |
| Real timeout and replacement with one slot in N1 | **Closed** (was PENDING in the `c2d46151` status) | the `timeout_replacement` step above |
| Memory of `bim-service`, demo idle | **Measured** | cgroup 88-95 MiB of 256 MiB, `oom_kill` 0; parent RSS 59.7 MB (peak 59.7), child 53.9 MB (peak 56.8-57.1) |
| Remote cancellation end to end | **Closed** | `tools/cancel_probe.py` via `lab_compose seed` with `DEMO_SEED_TOOL=cancel_probe.py`: `passed`, `ok` true, 9 checks ok, 0 findings; job `cancelled` about 1.0 s after `POST /v1/jobs/{id}/cancel` ([qa/ENGINE_CANCELLATION_E2E.md](qa/ENGINE_CANCELLATION_E2E.md)) |
| Snapshot `invalid_instance` of the seed | **Cause found** | the 0.1.x package pins a contract version that 0.2.0 does not install (`contract_not_installed`); kept as evidence, 422 `snapshot_not_recompilable`; revision 2 of `simple-seq` runs ([qa/SNAPSHOT_INVALID_INSTANCE.md](qa/SNAPSHOT_INVALID_INSTANCE.md)) |
| Two stale snapshots of other owners (`lab-member`, `lab-viewer`) | **Open, residual risk** | status `blocked` (`snapshot_conflict`); not decided to delete |
| PostgreSQL 16 real | **Closed** | 113 passed, 0 skipped, 0 failed at `59ef9749` ([qa/PG_REAL_RUN.md](qa/PG_REAL_RUN.md)) |
| Lab with SPACE enabled and real contracts | **NO EJECUTADO** | SPACE on hold, zero calls; `DEMO_SPACE_ENABLED=false` |
| By-eye mobile/desktop check | **Manual**, not recorded as done | the automated visual QA found 0 problems |

Operations: jobs queued before a deployment pin the previous version of the bundled engine registration and fail with
`registration_changed`; drain the queue or let them finish before `up`. A first `process_probe.py` run without the N1 flags gave
`ok` false because it expected the N2 values; that was a wrong use of the probe, not a service failure.

Where the history below says "PENDING" for the N1 timeout, "one old snapshot ... `invalid_instance`" without a cause, or 70
passed for PostgreSQL, it is **superseded** by the table above.

- The demo runs `bim-service` in **process mode, profile N1** (`compose.lab-process.json`: 1 process, body up to **6 MiB**, the
  256 MiB container intact). This is the human's decision of 2026-10-14; N2 (`compose.lab-process-n2.json`: 2 workers, 2 MiB) is
  an alternative and history. Deployed and probed with `process_probe.py` at `c2d46151` (details:
  [qa/PROCESS_DEPLOYMENT.md](qa/PROCESS_DEPLOYMENT.md), [qa/PROCESS_PROBE.md](qa/PROCESS_PROBE.md)). `compose.lab.json` (thread
  mode, 16 MiB) is the rollback.
- Seed at `c2d46151`: idempotent; it created the revision `simple-seq:2`; one old snapshot could not be recompiled under the new
  IR (`invalid_instance`, in `recompileFailed`). A first smoke/Playwright run in N1 on `bef53047` **failed** (smoke 6/9 with
  `422 contract_not_installed`, Playwright 29 passed / 1 failed) because the seeded snapshots carried compiler 0.1.0 after the IR
  cut-over; fixed by the cut-over change (`9bbc189f`) and re-verified at `c2d46151`.
- `smoke_lab.py` gives **9/9** steps in 6.0 s at `c2d46151` with `DEMO_SPACE_ENABLED=false`.
- Playwright against the live lab (the `e2e` service): **30 passed, 0 failed, 0 skipped** at `c2d46151` (summary
  2026-10-14T13:41:20Z). `docs/qa/E2E_PLAN.md` still has the older wording ("written, not executed"); the run supersedes it.
- The PostgreSQL 16 concurrency harness gave **70 passed, 0 skipped** at `bef53047` (67 plus 3 plan-concurrency tests;
  migrations up to `b6c7d8e9f0a1`); it runs separately from the lab, see [PG_HARNESS.md](qa/PG_HARNESS.md).
- **Pending, no evidence yet** (at `c2d46151`; **superseded**: measured at `31b7de6f`, see the current status): the real
  timeout and replacement with one slot in the N1 container.

**Observation at `b2780381`, 2026-10-14 (history; the demo then ran N2, which is superseded as the profile in force):** smoke
9/9, Playwright 30 passed / 0 failed / 0 skipped, PostgreSQL 67 passed / 0 skipped.

**Earlier observation, 2026-10-13 at SHA `5aebc7c8` (history):**

- `lab_compose up` leaves all 11 services healthy.
- `seed_lab.py` is idempotent, with one exception: when the BIM toolchain changes
  (its `irDigest`), the seed creates a new revision of the case (`simple-seq:2`).
- `smoke_lab.py` gave **9/9** steps in 24.4 s with `DEMO_SPACE_ENABLED=false`.
  `plan_usage` is omitted (it needs SPACE, i.e. `--with-space`).
- Since that run one service was added (`e2e`, see "What
  runs" and "Browser specs and visual QA inside the lab") and the volumes were renamed
  to `lab-pg-3` and `lab-artifacts-2` (see "Unprivileged containers"). At that time the new
  file, the image `frontend/Dockerfile.e2e` and the sequence below had been checked statically only; they have been built and
  run since (the Playwright result above).

**Still not executed** (also at `31b7de6f`): the by-eye mobile/desktop check (it stays manual, see "Mobile and desktop check"),
and the lab with `DEMO_SPACE_ENABLED=true` and real contracts (SPACE has no service or contracts,
see "SPACE status"). The lab runs with
`DEMO_SPACE_ENABLED=false`: an open development gate with no real entitlements.
A static check also exists (`lab/tests/test_lab_compose.py`).

## What runs

| Service | Image / build | `mem_limit` | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | 384 MiB | volume `lab-pg-3`, `PGDATA=/var/lib/postgresql/data/pgdata`, `pg_isready` healthcheck, `user: 70:70` |
| `redis` | `redis:7-alpine` | 96 MiB | volume `lab-redis`, AOF, `maxmemory 64mb` + `noeviction`, `user: 999:1000` |
| `engine-random-search` | `engines/random-search/Dockerfile` | 320 MiB | JVM, `-Xmx192m` |
| `engine-many-heuristic` | `engines/many-heuristic/Dockerfile` | 320 MiB | JVM, `-Xmx192m` |
| `engine-evolutionary-heuristics` | `engines/evolutionary-heuristics/Dockerfile` | 320 MiB | JVM, `-Xmx192m` |
| `engine-minizinc` | `engines/minizinc-csp/Dockerfile` | 192 MiB | Node, `--max-old-space-size=96` |
| `bim-service` | `bim-toolchain`, `packages/bim-service/Dockerfile` | 256 MiB | port 8080, `/healthz`, tokens file in a tmpfs |
| `gateway` | `openbinding-gateway/Dockerfile`, tagged `openbinding-lab-gateway:latest` (the only build of this image) | 640 MiB | `alembic upgrade head` through the image entrypoint, then uvicorn with `--proxy-headers` |
| `worker` | `image: openbinding-lab-gateway:latest`, no build | 448 MiB | dramatiq, one process, 2 threads, queues `default` and `analysis` |
| `web` | `frontend/Dockerfile`, target `lab` (config `frontend/nginx.lab.conf` baked in) | 96 MiB | nginx: production build of the frontend, `/api/` to the gateway without the prefix; **the only published port** |
| `seed` | `image: openbinding-lab-gateway:latest`, no build | 384 MiB | `profiles: ["seed"]`; not started by `up` |
| `e2e` | `frontend/Dockerfile.e2e` (`mcr.microsoft.com/playwright:v1.62.1-jammy`, the version `pnpm-lock.yaml` resolves for `@playwright/test`) | 576 MiB | `user: pwuser`, volume `lab-e2e` on `/results`; runs the live specs when `DEMO_E2E=1`, then stays alive; healthy when `/results/done` exists |

**Memory sum of all `mem_limit`: 4032 MiB** (3.9375 GiB; lab ceiling 4096 MiB,
64 MiB to spare). It was 3456 MiB before `e2e` (576).
It includes `seed`, which only runs on demand,
so the steady state is 3648 MiB. `test_lab_compose.py` and
`test_container_hardening.py` recompute the sum and fail if it is not 4032 or
if this document does not state it. `mem_limit` bounds the container, not the
page cache of the named volumes, and image builds are not limited by it.

**Unprivileged containers.** The gateway image (`gateway`, `worker`, `seed`) runs as
UID/GID 10001 with no login shell; `bim-service` already did. Root inside a rootless
container is not root on the host, but the unprivileged user is still the practice
that limits a compromised process. Consequences for the lab:

- `/run/bim` is a tmpfs with `mode: 1023` (0o1777) in all three gateway-image services,
  so UID 10001 can write the token file (still created with `umask 077`).
- `lab-artifacts-2` is writable by 10001 because `/var/lib/openbinding/artifacts` exists in
  the image owned by 10001 and an empty named volume inherits that owner. The earlier
  `lab-artifacts` volume was created by an image that ran as root and kept root as owner. A
  chown one-shot service (`artifacts-init`) was tried and failed with `chown: changing
  ownership ... Operation not permitted`: the supervisor drops every capability, so the
  container has no `CAP_CHOWN`. It was removed, and the lab uses **new volumes**
  instead: `lab-artifacts` became `lab-artifacts-2` and `lab-pg` became `lab-pg-3`
  (`gateway`, `worker` and `seed` mount `lab-artifacts-2`; `postgres` mounts `lab-pg-3`).
  No service runs as root and none depends on a one-shot.
- **Orphaned volumes.** The old `lab-artifacts` and `lab-pg` are not deleted and no
  service mounts them any more. The old synthetic database and its artifacts are kept
  unused. Recreating the database on `lab-pg-3` means it starts empty: run `seed`
  again to populate it. `lab-pg-2` is also kept unused: its initial password was lost
  (the data is synthetic).
- The gateway `Dockerfile` installs `bim-core`, `bim-client` and `".[test]"` in **one**
  `uv pip install --system --no-sources` command. With uv pinned to 0.8.22 the resolver does
  not count an already installed `bim-core` as a candidate, so a separate earlier install
  made `".[test]"` fail with "bim-core was not found in the package registry ...
  unsatisfiable". As direct requirements in the same command, the local packages satisfy
  the `bim-core>=0.2,<0.3` dependency by name. Keep them together
  (`test_the_local_bim_packages_install_in_the_same_command_as_the_gateway`).
  `test_container_hardening.py` requires that no service runs as root, that
  `artifacts-init` does not exist, and that the image directory is owned by 10001.
- `bim-service` has `cpus: 1.5` and `pids_limit: 256` in addition to `mem_limit`.
  These are plain Compose service attributes; `mem_limit` is unchanged, so the sum
  above is too. The controller's validator accepted them: the container runs with 1.5 CPUs and
  `pids_limit` 256 (`docs/qa/PROCESS_DEPLOYMENT.md`; 6 pids were counted in the N2 container after its probe at `ce7229b2`).
- **`bim-service` memory (256 MiB, unchanged), thread mode of `compose.lab.json` (the rollback; the demo now runs the
  process profile N1 described in the next item).** Its environment sets
  `BIM_SERVICE_MAX_BODY_BYTES=16777216` (16 MiB, not the 32 MiB default),
  `BIM_SERVICE_MAX_CONCURRENCY=2`, `BIM_SERVICE_MEMORY_BUDGET_BYTES=134217728` (128 MiB)
  and `BIM_SERVICE_MAX_PENDING_BODY_BYTES=33554432` (32 MiB). Why not 32 MiB: the measured
  figures (`bim-toolchain/docs/SERVICE.md`, "Memory budget") are 55451648 bytes of resident
  memory at rest and about 268 MiB for one request of 32 MiB, against a limit of 268435456
  bytes, so a body of 32 MiB cannot be run in this container and the lab does not advertise
  it (`GET /bim/v1/capabilities` publishes the 16 MiB). The sizing: a request is charged 8
  times its body (`BODY_MEMORY_FACTOR`, an **estimate, not a guarantee**: 7.5x to 8.4x was
  measured), so the 128 MiB budget admits at most 16 MiB of bodies at once, the one request
  at the limit alone or two smaller ones; a request whose estimate can never fit the budget is
  refused with 413 `memory_budget_exceeded` before it is read, and one that fits later with
  429 `memory_budget` (`Retry-After`). The bodies waiting for a slot or running add up to at
  most 32 MiB; more is refused before the body is read (429 `pending_body_bytes`). Worst
  case from these numbers: 52.9 MiB at rest + 8.4 x 16 MiB admitted + 2 x 16 MiB waiting
  (buffered twice while joined) = about 219 MiB, 37 MiB below the limit.
  `test_bim_service_memory_limits_fit_its_mem_limit` recomputes it. This follows from the
  measurements and was **not run in a 256 MiB container**; the memory that is not
  proportional to a request body (a package that inflates to up to
  `BIM_MAX_EXPANDED_BYTES`, 64 MiB by default) is not covered by the budget. The default
  `MAX_JSON_BODY_BYTES` of the gateway is also 16 MiB; the size of the requests it sends to
  `bim-service` was not checked against the new limit.
- **`bim-service` with worker processes (alternative manifests).** `compose.lab-process-n2.json`
  and `compose.lab-process.json` run the same service with `BIM_SERVICE_EXECUTOR=process` in the
  same 256 MiB container (bodies of 2 MiB and 6 MiB, not 16 MiB). They differ from
  `compose.lab.json` only in the environment of `bim-service`, so the memory sum stays
  4032 MiB, and `compose.lab.json` is the rollback. Profiles, fit rule, activation with
  `lab_compose up file=...` and what to verify: [qa/PROCESS_DEPLOYMENT.md](qa/PROCESS_DEPLOYMENT.md).
  **The demo currently runs `bim-service` in process mode with `compose.lab-process.json`** (N1: 1 process, body up to 6 MiB, so
  `GET /bim/v1/capabilities` publishes 6 MiB, not 16 MiB), deployed and probed in the real 256 MiB container at `c2d46151`
  (smoke 9/9, probe exit 0, `oom_kill` 0; see the deployment and probe documents). The sum of `mem_limit` is still 4032 MiB.
  The 16 MiB / thread description above is `compose.lab.json`, the rollback (`lab_compose up file=compose.lab.json`).
  `compose.lab-process-n2.json` (N=2, 2 MiB) was deployed earlier (`ce7229b2`) and is now an alternative.
- The image build and `up` with the new ownership were first covered by static checks only (no Docker in the authoring
  environment). They have been run since by the supervisor's `lab_compose`: the stack was up for the smoke (9/9) and for
  Playwright (30/0/0) at `b2780381`. A separate check of the ownership of `lab-artifacts-2` is not recorded in this document.

Compared with `docker-compose.yml`: a single `worker` consumes both queues
(the stack runs a second one for `analysis` with one thread); the
`engine-multi-heuristic` example, adminer, qacobench and the dev profile are
left out; there is no TLS and no examples alias (the frontend reads examples
through `/v1/examples`).

## Variables

The supervisor supplies these. All values below are **synthetic examples, not
secrets**; use your own.

| Variable | Used by | Example |
| --- | --- | --- |
| `DEMO_PG_PASSWORD` | postgres, gateway, worker, seed | `lab-example-pg-password` (letters, digits, `-`, `_`, `.` only: it is embedded in a URL) |
| `DEMO_JWT_SECRET` | gateway **only** (as `GATEWAY_JWT_SECRET`) | `lab-example-jwt-signing-value` (make it long and random) |
| `DEMO_FERNET_KEY` | gateway, worker, seed (as `FEDERATION_SECRET_KEY`, the name `core/settings.py` reads) | a Fernet key: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `DEMO_BIM_TOKEN` | bim-service, gateway | `lab-example-bim-token-0123456789abcdef` (one line, 32 to 127 printable ASCII characters without spaces: `bim-service` refuses to start otherwise) |
| `DEMO_SPACE_ENABLED` | gateway, worker, seed (as `SPACE_ENABLED`) | `false` or `true`; see "SPACE status" below. `false` is the functional demo without SPACE plans; `true` needs a SPACE development service and contracts |
| `DEMO_SPACE_PRICING_VERSION` | gateway, worker, seed (as `SPACE_PRICING_VERSION`); seed also as `SPACE_DEV_PRICING_VERSION` | `0.1.0` (must exist in SPACE/SPHERE) |
| `DEMO_SPACE_DEFAULT_PLAN` | gateway, worker, seed (as `SPACE_DEFAULT_PLAN`) | `BASIC` (must exist in the pricing) |
| `DEMO_SPACE_DEV_SERVICE` | gateway, worker and seed (as `SPACE_SERVICE_NAME`); seed also as `SPACE_DEV_SERVICE_NAME` | the name of a SPACE *development* service that exists in SPACE (for example `openbinding-dev`); the gateway and worker read and write contracts only on it, and `seed_lab.py --space-contracts` refuses `openbinding` (and any production name) and requires it to equal `SPACE_SERVICE_NAME` |
| `DEMO_SPACE_DEV_PLAN` | seed **only** (as `SPACE_DEV_PLAN`) | a plan of that service's pricing version, for the contracts of the synthetic users |
| `DEMO_SEED_TOOL` | seed | `seed_lab.py`, or `smoke_lab.py` for the API smoke (a file of `openbinding-gateway/tools/`; `seed_dev.py` also exists; `cancel_probe.py` and `diagnose_snapshots.py` were run the same way, see [qa/ENGINE_CANCELLATION_E2E.md](qa/ENGINE_CANCELLATION_E2E.md) and [qa/SNAPSHOT_INVALID_INSTANCE.md](qa/SNAPSHOT_INVALID_INSTANCE.md)) |
| `DEMO_SEED_ARGS` | seed | `--verbose` for a seed, `--with-space` for the smoke (see "Seeding" and "API smoke") |
| `DEMO_SEED_PASSWORD` | seed (`seed_lab.py`, `smoke_lab.py`) and e2e (the live specs sign the synthetic users in with it) | any synthetic value of 10+ characters; the supervisor injects it; `compose.lab.json` passes it only to `seed` and `e2e`, as `${DEMO_SEED_PASSWORD}` with no value and no default |
| `DEMO_E2E` | e2e | `1` runs the live specs when the service starts; anything else (`0`, unset) only creates `/results/done` and sleeps. See "Browser specs and visual QA inside the lab" |
| `DEMO_PUBLIC_ORIGIN` | gateway, worker (`PUBLIC_BASE_URL` only), seed | optional; default `http://localhost:18100`. The origin the browser reaches the lab by, with no trailing slash (for example `https://demo.example.org`). It becomes `PUBLIC_BASE_URL` and `FRONTEND_URL` (the worker gets only `PUBLIC_BASE_URL`) and is appended to `CORS_ALLOW_ORIGINS` after `http://localhost:18100,http://127.0.0.1:18100`. Unset or empty, the URLs stay `http://localhost:18100` and the list gains an empty item that `Settings.cors_origin_list` discards, so CORS allows only the two local origins. The published port is unchanged (`127.0.0.1:18100`) |
| `SMOKE_BASE_URL` | seed (`smoke_lab.py`) | fixed in the file to `http://web:8080` on `seed` only |

The file writes no SPACE service or plan name: those come from `DEMO_*`
references. `DEMO_SPACE_DEV_SERVICE` is the one name of the SPACE service of the
lab: `compose.lab.json` passes it as `SPACE_SERVICE_NAME` to the gateway and the
worker (the setting `space_service_name` in `core/settings.py`, default
`openbinding`, shape `[a-z0-9][a-z0-9_-]{1,62}`) and to `seed` both as
`SPACE_SERVICE_NAME` and as `SPACE_DEV_SERVICE_NAME`. So the contracts that
`seed_lab.py --space-contracts` creates are the ones the gateway reads, and the
lab never touches the production service `openbinding`: the same SPACE
organization does not isolate credentials, so the target is chosen explicitly
per environment. The gateway logs the effective service name (never a key) when
it starts. If the variable is unset, compose gives an empty value, which the
gateway refuses to start with.

Private, supplied by the supervisor and only referenced as `${NAME}` (the file
holds no value and no default): `SPACE_URL`, `SPACE_API_KEY`, `SPHERE_URL`,
`SPHERE_API_KEY`, `SPHERE_ORGANIZATION_ID`, `SPACE_ORGANIZATION_ID`. The last
one is passed only to `seed`: `core/settings.py` does not read it, but
`tools/remote_probe.py` exits with "SPACE_ORGANIZATION_ID is not set" without
it. The retired
destructive SPACE key is not used anywhere, and no `VITE_*` variable carries a
key (the frontend is built with `VITE_API_BASE_URL=/api` only).

### SPACE status

`DEMO_SPACE_ENABLED` is passed as `SPACE_ENABLED` to `gateway`, `worker` and
`seed`; the file holds no literal.

- `false`: functional demo **without SPACE plans**. With `APP_ENV=dev` the
  gateway builds the stateless open gate (`space_client.build_gate`): every
  functional capability is granted, there are no plans, no counters and no real
  entitlements. `SPACE_URL`, `SPACE_API_KEY` and the contracts are not needed in
  this mode (`SpacePricingGate` is the only code that requires them, and it is
  not built). Nothing in `core/settings.py` or `build_gate` requires other
  variables; only `APP_ENV=prod` refuses `false`, and the lab is `dev`. Run the
  smoke without `--with-space`.
- `true`: the gateway reads and writes contracts on the SPACE development
  service (`DEMO_SPACE_DEV_SERVICE`), so it needs that service and a contract per
  synthetic user. **Today this is blocked**: SPHERE accepted the private pricing
  `openbinding-dev` 0.1.0, but SPACE rejected the same YAML with HTTP 400 ("The
  createdAt field must be a string in the format yyyy-mm-dd or a valid Date
  object"), so SPACE has no service and no contracts. Until that is resolved,
  `/v1/users/me`, job launches, etc. answer `503 pricing_unavailable` (the
  intended fail-closed behaviour). See `docs/qa/REMOTE_TOOLS.md`, "First real
  application".

Observed remotely on 2026-10-13:

- **SPACE**: healthy (healthcheck 200) but with **no services and no contracts**,
  and it **rejected with 400** the pricing whose `createdAt` was
  `YYYY-MM-DDTHH:mm:ssZ` ("The createdAt field must be a string in the format
  yyyy-mm-dd or a valid Date object"). The lab therefore runs with
  `DEMO_SPACE_ENABLED=false` until the human decides how to proceed.
- **SPHERE**: **accepted** the private pricing `openbinding-dev` 0.1.0 (id
  `6acda0164b2b5b01c587c19a`, `private=true` verified, `createdAt`
  `2026-10-13T03:05:58Z`).

Fixed in the file: `APP_ENV=dev`, `CAS_ENABLED=false`,
`SPHERE_ENABLED=true`, `MAX_CONCURRENT_JOBS_PER_USER=3`,
`CORS_ALLOW_ORIGINS=http://localhost:18100,http://127.0.0.1:18100`,
`PUBLIC_BASE_URL` and `FRONTEND_URL` `http://localhost:18100`.
`FORWARDED_ALLOW_IPS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`.

The gateway takes the client address (login throttling) from `X-Forwarded-For`
and trusts that header from the private ranges above. The only hop in front of
it is the `web` nginx, which **sets** `X-Forwarded-For` to the address it sees
(`$remote_addr`) in its three proxy blocks instead of appending to the header
the client sent (`$proxy_add_x_forwarded_for`), so a client cannot forge its
address. Anything that is added in front of `web` later must itself be trusted
and must be accounted for there. `frontend/nginx.lab.conf` also no longer says
the compose file drops capabilities: `compose.lab.json` declares no `cap_drop`;
the lab supervisor drops every capability of its containers.

BIM variables (`BIM_MODE=http`, `BIM_SERVICE_URL=http://bim-service:8080`,
`BIM_SERVICE_TOKEN_FILE=/run/bim/token`) are defined on the gateway, and its
start command writes the file from `DEMO_BIM_TOKEN` into a tmpfs
(`umask 077`). The gateway reads them through `integrations/bim.py`
(`BIM_MODE=http`).

`BIM_SERVICE_ALLOW_INSECURE_HTTP=true` is set only on `gateway`, `worker` and
`seed`. The service is reached over plain `http` inside the lab's private Docker
network with a synthetic token, and `bim_client` refuses a bearer token over
plain `http` to a non-loopback host unless that is opted into explicitly. The
gateway logs a warning at startup. Do not copy this to a real deployment: the
gateway now refuses this flag (and `FEDERATION_REQUIRE_HTTPS=false`) when
`APP_ENV=prod`; the lab is `dev`.

## Running it with lab_compose

The controller tools that exist for the lab (named here; their arguments are those of the tool descriptions, which this
document does not copy): `lab_compose` with `validate`, `up`, `seed`, `down`, `status`, `metrics`, `logs`, `cleanup`, `archive`
and `result`; `lab_report`; `lab_screenshot` (lists and returns the PNG/JPEG/WebP images of the `lab-e2e` volume, for instance
`screenshots/_summary.png`, see `docs/qa/E2E_PLAN.md`); `anonymous_http` (`GET` and `HEAD` to the official SPHERE origin, see
`docs/qa/SPHERE_PRIVACY.md`); and `archive_worktrees`. `metrics` gives the memory figures, `oom_kill` and the number of pids
that `docs/qa/PROCESS_DEPLOYMENT.md` quotes.

**The `environment` argument of `lab_compose` is a PATCH (merge) over the stored variables.** Omitted or `{}` keeps all of them,
only the keys sent explicitly are replaced, and `validate` uses the same semantics. (Before, an `environment` replaced the whole
stored set and a partial one lost the other variables; that was the cause of the incident in `docs/qa/PG_ROLE_RESET.md`, and it is
no longer the behaviour.) What `seed` does with the saved environment is described in step 3 below (that text predates this
change and was not re-verified).

1. `validate` the file. Expect no complaint; if it refuses something, the
   message is the rule to adapt `compose.lab.json` to.
2. `up`: `docker compose up --detach --build --wait`. The first build compiles
   three Maven projects, installs the frontend with pnpm and several Python
   images; it needs network access to Maven Central, npm, PyPI and the Debian
   archive, and takes a long time. `--wait` returns when every healthcheck is
   green; start periods are 60 s for the gateway and the engines.
3. `seed`: `docker compose run --rm --no-deps seed`. Runs
   `python tools/${DEMO_SEED_TOOL} ${DEMO_SEED_ARGS}` in the gateway image with
   the gateway's environment (minus the session secret and BIM; see below).
   **`lab_compose seed` uses the environment saved by the last `up`; an
   environment passed to `seed` itself is ignored.** To change `DEMO_SEED_TOOL` or
   `DEMO_SEED_ARGS`, repeat `up` with the new values and then run `seed`.
4. `status` / `logs`: look at `web`, `gateway`, `worker` first.
5. `down` removes containers and the network and **keeps the named volumes**
   (`lab-pg-3`, `lab-redis`, `lab-artifacts-2`), so data survives a restart. Only
   an explicit volume removal deletes it.

### Seeding

The seed tools travel in the gateway image (`COPY openbinding-gateway/tools/
tools/` in the Dockerfile); `seed` mounts no host code. They used to be
bind-mounted, but the seed runs as uid 10001 and under rootless Docker a
bind-mounted `tools/` can be unreadable for that uid (`python: can't open file
'/app/tools/seed_lab.py': [Errno 13] Permission denied`). Two consequences: when
a tool changes you must rebuild with `up` before running `seed`, because the
seed runs the code of the image, not of the checkout; and the tools are
read-only to the unprivileged user, so a tool cannot write beside itself
(`seed_dev.py` writes `tools/analysis-manifest.json` by default; pass
`--analysis-manifest /tmp/analysis-manifest.json` when you use the analysis
options).

`seed_dev.py` creates its users directly in the database; it does not call the
API. For that reason `seed` does not get `GATEWAY_JWT_SECRET`: a tool that logs
in over HTTP sends a password and receives a token signed by the gateway, so it
never needs the secret, and keeping the secret in one service is the point of
`tests/test_compose_worker_secrets.py`. The seed also gets no BIM variables.
If a later seed tool needs either, change `SEED_OMITS` in
`lab/tests/test_lab_compose.py` together with the compose file.

## Browser specs and visual QA inside the lab

The `e2e` service runs Playwright (Chromium) **inside** the lab network against
`http://web:8080` with the synthetic users, so nothing has to be done on a Mac.
It is built from `frontend/Dockerfile.e2e` and runs `frontend/e2e/live/run.sh`
with `frontend/playwright.live.config.ts`:

- `DEMO_E2E=1`: `pnpm exec playwright test -c playwright.live.config.ts` (one
  worker, `list` reporter plus a JSON report, trace on failure), then it prints
  `E2E_FAILED ...` for each failing test and one final line
  `E2E_SUMMARY passed=N failed=N skipped=N`. The visual QA prints one
  `VQA viewport=<desktop|mobile> page=<screen> result=<PASS|FAIL|SKIPPED> ...` line per
  screen and size, and a `VQA_PROBLEM ...` line per finding.
- Whatever `DEMO_E2E` is, it ends by creating `/results/done` and sleeping
  (`sleep infinity`). Its healthcheck is `test -f /results/done`, so `up --wait`
  returns when the run is over (the start period is 3600 s) and does not fail on a
  stopped container. An earlier run's `done` is deleted first.
- `/results` is the named volume `lab-e2e`: `done`, `report.json`,
  `screenshots/<desktop|mobile>-<screen>.png`, `visual-qa-*.json` and
  `test-output/` (traces of failures). **The controller cannot open volumes**, so
  `report.json`, the traces and the other files are not readable: `logs e2e` is, and so are the images of the volume through
  `lab_screenshot` (for instance `screenshots/_summary.png`, the summary image that `run.sh` renders; `docs/qa/E2E_PLAN.md`).

Exact sequence with `lab_compose`:

1. `down` **if the checkout changed** (a new SHA): it removes the containers and
   keeps the volumes. The `e2e` image is rebuilt by `up` because it copies `frontend/`.
2. `up` with `DEMO_E2E=0`: builds everything (the first time the Playwright image
   and `pnpm install` take a while), starts the stack and `e2e` creates `done` and sleeps.
3. `seed` with `DEMO_SEED_TOOL=seed_lab.py` (`DEMO_SEED_ARGS=--verbose`) and a
   `DEMO_SEED_PASSWORD`. Wait for it to finish; `seed` uses the environment saved by the
   last `up`.
4. `up` again with `DEMO_E2E=1` (and the **same** `DEMO_SEED_PASSWORD`): the changed
   variable recreates `e2e`, which runs the specs; `--wait` returns when it is done.
   (`up` with an unchanged environment does not rerun anything: to repeat a run, `up`
   with `DEMO_E2E=0` and then with `DEMO_E2E=1`, or `down` and `up`.)
5. `logs e2e`: look for `E2E_SUMMARY`, then `E2E_FAILED`, `E2E_ERROR`, `VQA_PROBLEM`
   and `VQA_HTTP4XX`. `logs gateway` and `logs web` show what the specs did on the other side.

Things to know before reading the result:

- The gateway throttles logins to 10 per user per 5 minutes. The functional specs
  run only in the `desktop` project, `mobile` runs only the visual QA, and the
  helper waits out a `429`; still, two complete runs within five minutes can wait.
- `04-job-random-search` starts one real job as `lab-owner` (so the lab keeps it) and
  the visual QA opens a finished job of `lab-owner` as "a result". With
  `DEMO_SPACE_ENABLED=true` and no contract the launch is `503 pricing_unavailable` and
  `04` fails; with `false` (the lab's current mode) there is no plan: the plan page shows
  an empty plan name and features it "Can’t confirm" (the frontend has no dedicated
  notice for the open gate).
- **Not verifiable from here**: anything a human would judge by eye (spacing, colour,
  taste) in the individual screenshots (the controller can see the images of the volume
  through `lab_screenshot`, but this document records no by-eye review of them), and the
  Chromium flags in a real container (`--no-sandbox`, `--disable-dev-shm-usage`, one worker,
  576 MiB) beyond the fact that the run finished. The run itself was executed at `b2780381`:
  30 passed, 0 failed, 0 skipped.

## Reaching it from the Mac

On the Mac:

```sh
ssh -L 18100:127.0.0.1:18100 <host-lab>
```

then open <http://localhost:18100>. Both `http://localhost:18100` and
`http://127.0.0.1:18100` are in `CORS_ALLOW_ORIGINS`; any other origin (for
example the lab host's name) is not. Through the proxy the API is at
<http://localhost:18100/api/health/ready>.

## Synthetic users

`openbinding-gateway/tools/seed_lab.py` (`DEMO_SEED_TOOL=seed_lab.py`) creates
them, idempotently, with the real roles. Every user has the same password: the
value of the variable `DEMO_SEED_PASSWORD` (chosen by whoever runs the seed, at
least 10 characters). It is not documented here and has no default. Emails are
`<username>@example.org`. Do not reuse that password anywhere.

| Username | Platform role | Organization role |
| --- | --- | --- |
| `lab-admin` | `ADMIN` | none |
| `lab-owner` | `USER` | `OWNER` of `lab-main` |
| `lab-orgadmin` | `USER` | `ADMIN` of `lab-main` |
| `lab-member` | `USER` | `MEMBER` of `lab-main` |
| `lab-viewer` | `USER` | `VIEWER` of `lab-main` |
| `lab-outsider` | `USER` | `OWNER` of `lab-other` (no access to `lab-main`) |

Data: organizations `lab-main` (sponsor `lab-owner`) and `lab-other`; project
`lab-main/bim-demo` (private) with case `simple-seq`, built from
`examples/demo/01_simple_seq`. The seed launches no jobs. Observed with
`seed_lab.py --verbose`: 6 users, 2 organizations, 1 project, 1 case with 3
artifacts and 6 API keys. With `SPACE_ENABLED=true`
the users also need a contract on the development service
(`DEMO_SEED_ARGS='--space-contracts'`, see `docs/qa/REMOTE_TOOLS.md`).

## API smoke

`openbinding-gateway/tools/smoke_lab.py` checks the demo end to end through the
proxy, with the users above and no browser. It runs in the `seed` service (inside
the lab network, where `web:8080` resolves):

```sh
DEMO_SEED_TOOL=smoke_lab.py DEMO_SEED_ARGS='--with-space' docker compose run --rm --no-deps seed
```

Use `DEMO_SEED_ARGS='--skip 6,7,8,9'` to leave out the optional steps. Drop
`--with-space` when the users have no SPACE contract or `DEMO_SPACE_ENABLED=false`:
step `plan_usage` runs only with that flag, and the other steps complete against
the open gate. It reads `DEMO_SEED_PASSWORD`
from the environment (the same value used to seed), takes the base URL from
`SMOKE_BASE_URL` or `--base-url` (default `http://web:8080`), prints one JSON
document with `{name, ok, blockedByRemote, detail}` per step, never prints
passwords, tokens or headers, and exits non-zero if any step fails (1), is only
blocked by the remote (3) or the configuration is wrong (2).

**Blocked by the remote.** With `SPACE_ENABLED=true` the gateway fails closed when
it cannot read an account's entitlements: `GET /v1/users/me`, `/v1/users/me/usage`,
job launches and study runs answer `503 pricing_unavailable`. When SPACE has no
service or contract for the synthetic users that is not a defect of the gateway,
so the step that meets it is reported `ok: false, blockedByRemote: true` with the
reason ("SPACE has no service/contract for the synthetic users; run seed_lab
--space-contracts after remote_provision --apply") and the server's own message.
The summary keeps `failed` for real failures and counts `blocked` / `blockedSteps`
apart; a step with a real failure is never reported as blocked. The 503 text cannot
tell a missing contract from an unreachable SPACE (the gateway wraps both), so
check `remote_probe.py` before reading it as a seeding gap.

| Step | Checks |
| --- | --- |
| `proxy_and_spa` | `/healthz`, SPA index, SPA fallback on an unknown route, `/api/health/ready` |
| `login` | `lab-admin`, `lab-owner`, `lab-member`, `lab-viewer` and `lab-outsider` sign in with Bearer tokens |
| `owner_job` | `lab-owner` profile and projects; a minimal `random-search` job (`mode: seeded`, `optimization: {type: SINGLE, scalarization: weighted-sum}`, which the gateway requires in the request and the package does not carry) on the seeded package; result shape and the gateway's reevaluation provenance |
| `idempotency` | same key and body, same job; same key and other body, 409; another account, another job |
| `authorization` | 401 without token; viewer can launch a personal job on their own snapshot but cannot start a study run in the project, and reads the project job with redacted options; outsider reads neither; non-admins get 403 on `/api/v1/admin/*` |
| `concurrency_limit` | 5 simultaneous launches against `MAX_CONCURRENT_JOBS_PER_USER=3`: a 429 with `Retry-After`, slot freed afterwards |
| `cors` | preflight allowed from `http://localhost:18100`, refused from `http://evil.example` |
| `body_limit` | JSON over 16 MiB gets a 413 problem+json |
| `plan_usage` | (`--with-space`) plan and capabilities of the owner, no usage counters |
| `login_throttle` | 12 failed logins of a made-up user end in a 429 with `Retry-After`; the counter is per address and identifier |

It writes to the lab database only through the API (jobs of `lab-owner` and
`lab-member`, and once a study `smoke-lab` in `lab-main/bim-demo` so the project
has a job the viewer can read); it never registers users and never touches
SPACE or SPHERE. Running it again within five minutes finds the login throttle
already tripped for its probe user, which still counts as a pass. What it does
not cover (browser, Playwright, the visual mobile/desktop check) and the
assumptions of its first run are in `docs/qa/E2E_PLAN.md`.

**Run of 2026-10-13, SHA `5aebc7c8` (thread mode, `DEMO_SPACE_ENABLED=false`, without
`--with-space`): 9/9 steps passed in 24.4 s.** The later run at `b2780381` (process mode N2) also gave 9/9 (duration not
recorded in this document), and so did the run at `c2d46151` (process mode N1) in 6.0 s. `plan_usage` needs `--with-space`
and was omitted on 2026-10-13 (**not executed**); whether it was run at `b2780381` is not recorded here. Whether it was run at `c2d46151` is not recorded here either.

History: the first complete run passed 8 of 9 steps. The failing one,
`authorization` ("viewer cannot launch"), had a wrong expectation in the smoke:
`POST /v1/jobs` is personal work, so a viewer can launch on their own snapshot
(the expectation was corrected, as described in the table above). Note that this
backend behaviour is itself under review: see M1 in
[qa/SECURITY_REVIEW.md](qa/SECURITY_REVIEW.md). An earlier attempt had been
blocked by SPACE having no contracts (503 `pricing_unavailable`) and by a job
body without `optimization` (422, fixed).

## Mobile and desktop check

The measurable part is automated: `e2e/live/visual-qa.spec.ts` (see above and
`docs/qa/E2E_PLAN.md`) checks horizontal overflow, console and page errors, 5xx
answers, the main landmark, touch targets (mobile), clipped text and broken images on
the main screens at 1280 x 800 and 390 x 844, and takes a screenshot of each. It is part of the live
Playwright run (30 passed, 0 failed, 0 skipped at `b2780381`; the number of visual findings at that SHA is not restated
here). What follows is the by-eye check that stays manual, in the browser on
the Mac (DevTools, device toolbar), and is not recorded as done:

- Mobile: 390 x 844 (iPhone 14 class). Navigate home, login, cases, a job, the
  workbench; check the navigation, tables that scroll horizontally and the
  touch targets.
- Desktop: 1440 x 900.

Reload with the cache disabled after a rebuild: `index.html` is served with
`no-cache`, hashed assets for a year.

## Checks for the first start

These were the checks written before the first start. On 2026-10-13 every
service came up healthy; the only cause of a failure found was the `web` item
below (item 2). The other items were not individually recorded and remain a
diagnostic guide, not a list of verified results.

1. **Volume ownership.** `postgres` and `redis` run as explicit users
   (`70:70`, `999:1000`) because the supervisor drops every capability and the
   stock entrypoints, which start as root and `chown`/`su-exec`, cannot work
   without them. This relies on the named volume inheriting the ownership of
   the image directory on first use. Look at
   `logs postgres` and `logs redis`: `Permission denied` on
   `/var/lib/postgresql/data` or `/data`, `initdb: could not change
   permissions`, or `Can't open the append only file`. If the uid/gid of either
   image differs, fix `user` (`docker run --rm postgres:16-alpine id postgres`,
   `docker run --rm redis:7-alpine id redis`). A volume created by a failed
   first start keeps its wrong ownership; remove that one volume before
   retrying. `PGDATA` is the `pgdata` subdirectory of the volume so `initdb`
   creates it itself instead of needing the mount point to be empty and owned.
   Service, volume and network names may only use lowercase letters, digits and
   `-` (`^[a-z][a-z0-9-]{0,62}$`); `test_lab_compose.py` enforces it for both
   compose files.
2. **nginx as uid 101.** `web` is non-root, listens on 8080 and writes only to
   tmpfs mounts (`/run`, `/var/cache/nginx`). Its `entrypoint` is
   `nginx -g "daemon off;"`, which skips the image's `/docker-entrypoint.sh`:
   that script and `/docker-entrypoint.d/*` (`10-listen-on-ipv6-by-default.sh`,
   `20-envsubst-on-templates.sh`) try to rewrite `/etc/nginx/conf.d/default.conf`
   as uid 101, which fails. `frontend/nginx.lab.conf` is complete by itself.
   Look at `logs web` for
   `Permission denied`, `setgid`/`setuid`, or `open() "/run/nginx.pid" failed`.

   **Observed cause of the unhealthy `web`:** the configuration bind mount was
   empty for uid 101 under rootless docker. **The configuration is baked into the image, not bind-mounted.** The
   `lab` stage of `frontend/Dockerfile` (`FROM prod AS lab`) copies
   `frontend/nginx.lab.conf` over `/etc/nginx/conf.d/default.conf`; `prod`,
   the production image, is unchanged. An earlier version bind-mounted the
   configuration from the host; with rootless docker and an extracted,
   read-only copy of the tree that directory could be empty or unreadable for
   uid 101, so nginx started its workers with no `server` block: nothing
   listened on 80 or 8080 (`Connection refused`) and the healthcheck failed.
   If `web` is unhealthy
   with `Connection refused`, check the loaded configuration:
   `docker compose exec web nginx -T` must show `listen 8080;`, and
   `docker compose exec web ls -l /etc/nginx/conf.d` must list `default.conf`.
   The server block logs requests to stdout and errors (level `warn`) to
   stderr, so `logs web` shows them; `/healthz` is not logged.
   `curl http://127.0.0.1:18100/healthz` on the lab host must answer `ok`, and
   `/api/health/ready` must answer through the proxy.

   **Diagnosing an unhealthy `web`.** The image is `nginx:1.27-alpine` (target
   `lab` of `frontend/Dockerfile` adds the build output and the lab config). Its stock
   `/etc/nginx/nginx.conf` has `pid /run/nginx.pid` (a tmpfs), includes
   `conf.d/*.conf` and defines no server of its own; the `lab` stage replaces
   the stock `default.conf`, so the stock server on port 80 cannot clash. `wget` is the busybox applet. The healthcheck is
   `http_proxy= HTTP_PROXY= wget -T 3 -O /dev/null http://127.0.0.1:8080/healthz || exit 1`
   (15 s start period, 10 s interval, 6 retries). It has no `-q` so the reason
   is kept in the health log, and it blanks the proxy variables because busybox
   `wget` obeys them. To see the reason:
   `docker inspect --format '{{json .State.Health}}' <web container>` (last
   outputs of the probe), then `docker compose exec web wget -T 3 -O - http://127.0.0.1:8080/healthz`
   and `docker compose exec web ps`/`logs web`. Step 1 of `smoke_lab.py`
   (`proxy_and_spa`) requests `/healthz` on `http://web:8080` from the `seed`
   container, which tells a broken nginx from a broken probe: if it passes, the
   server is fine and only the probe inside `web` is at fault.
3. **Artifacts.** `lab-artifacts-2` is written by `gateway`, `worker` and
   `seed`, which run as 10001 (see "Unprivileged containers"); check that a job
   produces a downloadable artifact. The volume is theirs because it is new and
   inherits the owner of the image directory (there is no chown service: the
   container has no `CAP_CHOWN`). `docker-entrypoint.sh` does no
   `chown`. The seed's `tools/` is part of the image (made
   world-readable by the Dockerfile's `chmod -R a+rX /app`), not a bind.
4. **Tokens file.** `logs bim-service`: `bearer authentication enabled with 1
   token(s)`. The tmpfs is created root-owned, mode 1777, and the service runs
   as uid 10001 (it writes its own file, `umask 077`). An error saying the
   file cannot be read means the token is empty or shorter than 32 characters
   (`DEMO_BIM_TOKEN` unset).
5. **Migrations.** `logs gateway` should show `Applying database migrations...`
   before uvicorn starts; `worker` starts only after the gateway is healthy.
6. **Memory.** `docker stats --no-stream`: the JVMs at 320 MiB and
   `engine-minizinc` at 192 MiB are the likely OOM kills
   (`docker inspect -f '{{.State.OOMKilled}}' <container>`). The JVM options are
   `-Xmx192m -XX:MaxMetaspaceSize=96m` through `JAVA_TOOL_OPTIONS` (the
   evolutionary engine's Dockerfile uses `ENTRYPOINT`, so a `command` override
   would not reach it).

## Known limits

- Observed on 2026-10-13: build and `lab_compose up` completed with every
  service healthy, so the validator accepted the file, including `user` on
  `postgres`, `redis` and `web`, the `tmpfs` mounts of `web` and
  `entrypoint: []` on `worker`. The `web` failure on the way was the empty
  configuration bind mount (now baked into the `lab` target).
- Not executed: the by-eye mobile/desktop check, a recorded check of the ownership of the new volumes, and SPACE
  enabled with real
  contracts (SPACE has no service or contracts and rejects the pricing
  `createdAt` format; see "SPACE status"). `DEMO_SPACE_ENABLED=false` gives no
  real entitlements. (Playwright against the live lab, once listed here as never built or started, was executed:
  30 passed, 0 failed, 0 skipped at `b2780381`.)
- The `e2e` screenshots and report stay in the volume `lab-e2e`, which the controller
  cannot open: `logs e2e` and the images (`lab_screenshot`) are readable, `report.json` and the traces are not.
- `lab_compose seed` ignores the environment passed to it and uses the one saved
  by the last `up` (the `environment` of `up` itself is a PATCH over the stored variables, see "Running it with lab_compose").
- The proxy-header trust list covers the three private ranges Docker allocates
  networks from, because the address of `web` is not known in advance. The
  gateway is only reachable from the compose network, so those are its only
  possible peers.
- `engine-minizinc` at 192 MiB runs Node plus MiniZinc and its solver as child
  processes; a large model may not fit. Raising it means lowering something
  else to stay under 4096 MiB (the current total, 4032 MiB, leaves 64 MiB).
- A single worker serves both queues with two threads; analysis jobs and solve
  jobs can delay each other.
- `gateway`, `worker` and `seed` share one image, `openbinding-lab-gateway:latest`,
  built only by `gateway`. Reason: `up --build` rebuilds only services without a
  profile, and `run --rm --no-deps seed` reuses an existing image without
  rebuilding it, so a `seed` with its own `build` ran code from an earlier build
  (missing new modules and migrations). With the shared tag, every `up` refreshes
  the image the seed runs; `worker` keeps `depends_on: gateway` healthy so the
  image exists before it starts.
- `Dockerfile` of the gateway installs `uv` from `ghcr.io/astral-sh/uv:latest`
  and installs packages without the lock file, so the image is not
  reproducible.
- No TLS, no backups of the volumes, one host.
