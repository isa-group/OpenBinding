# OpenBinding lab demo (Docker)

`compose.lab.json` (repository root) starts a self-contained OpenBinding/BIM
demo on one lab host. It is reached from a Mac through an SSH tunnel; the only
thing published on the host is `127.0.0.1:18100`.

**Last recorded status (head `31b7de6f2002fb4b5e5f0c549a3bd4a2a2818fa2`, 2026-10-14).** Figures reported by the controller from the real
Docker laboratory (rootless); this document did not re-run them. Functional commits: `80ad32d4`,
`f5acbd70`, `ea955411`, `59ef9749`, `31b7de6f`. The observations of `c2d46151`, `b2780381` and `5aebc7c8` follow, tied to their
SHA, as history. **All of these records are about the removed setup in which the lab ran BIM in a separate `bim-service`
container; this document records no run of the current `compose.lab.json`, which runs BIM in process (see "What runs").**

At `31b7de6f`:

| Item | State | Result |
|---|---|---|
| `seed_lab` | **Closed** | Idempotent |
| `smoke_lab` | **Closed** | **9/9**: `proxy_and_spa`, `login`, `owner_job`, `idempotency`, `authorization` (24 checks), `concurrency_limit`, `cors`, `body_limit`, `login_throttle`. `plan_usage` skipped (SPACE on hold) |
| Playwright desktop + mobile | **Closed** | **30 passed, 0 failed, 0 skipped**, 0 visual problems (`E2E_SUMMARY passed=30`); screenshots reviewed: 131 images including `screenshots/_summary.png` |
| Remote cancellation end to end | **Closed** | `tools/cancel_probe.py` via `lab_compose seed` with `DEMO_SEED_TOOL=cancel_probe.py`: `passed`, `ok` true, 9 checks ok, 0 findings; job `cancelled` about 1.0 s after `POST /v1/jobs/{id}/cancel` ([qa/ENGINE_CANCELLATION_E2E.md](qa/ENGINE_CANCELLATION_E2E.md)) |
| Snapshot `invalid_instance` of the seed | **Cause found** | the 0.1.x package pins a contract version that 0.2.0 does not install (`contract_not_installed`); kept as evidence, 422 `snapshot_not_recompilable`; revision 2 of `simple-seq` runs ([qa/SNAPSHOT_INVALID_INSTANCE.md](qa/SNAPSHOT_INVALID_INSTANCE.md)) |
| Two stale snapshots of other owners (`lab-member`, `lab-viewer`) | **Open, residual risk** | status `blocked` (`snapshot_conflict`); not decided to delete |
| PostgreSQL 16 real | **Closed** | 113 passed, 0 skipped, 0 failed at `59ef9749` ([qa/PG_REAL_RUN.md](qa/PG_REAL_RUN.md)) |
| Lab with SPACE enabled and real contracts | **NO EJECUTADO** | SPACE on hold, zero calls; `DEMO_SPACE_ENABLED=false` |
| By-eye mobile/desktop check | **Manual**, not recorded as done | the automated visual QA found 0 problems |

Operations: jobs queued before a deployment pin the previous version of the bundled engine registration and fail with
`registration_changed`; drain the queue or let them finish before `up`.

Where the history below says "one old snapshot ... `invalid_instance`" without a cause, or 70 passed for PostgreSQL, it is
**superseded** by the table above.

- Seed at `c2d46151`: idempotent; it created the revision `simple-seq:2`; one old snapshot could not be recompiled under the new
  IR (`invalid_instance`, in `recompileFailed`). A first smoke/Playwright run on `bef53047` **failed** (smoke 6/9 with
  `422 contract_not_installed`, Playwright 29 passed / 1 failed) because the seeded snapshots carried compiler 0.1.0 after the IR
  cut-over; fixed by the cut-over change (`9bbc189f`) and re-verified at `c2d46151`.
- `smoke_lab.py` gives **9/9** steps in 6.0 s at `c2d46151` with `DEMO_SPACE_ENABLED=false`.
- Playwright against the live lab (the `e2e` service): **30 passed, 0 failed, 0 skipped** at `c2d46151` (summary
  2026-10-14T13:41:20Z).
- The PostgreSQL 16 concurrency harness gave **70 passed, 0 skipped** at `bef53047` (67 plus 3 plan-concurrency tests;
  migrations up to `b6c7d8e9f0a1`); it runs separately from the lab, see [PG_HARNESS.md](qa/PG_HARNESS.md).

**Observation at `b2780381`, 2026-10-14 (history):** smoke
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
| `gateway` | `openbinding-gateway/Dockerfile` (build secret `bim_toolchain_token`), tagged `openbinding-lab-gateway:${DEMO_LAB_PORT:-18100}` (the only build of this image) | 640 MiB | `alembic upgrade head` through the image entrypoint, then uvicorn with `--proxy-headers`; BIM runs in process |
| `worker` | `image: openbinding-lab-gateway:${DEMO_LAB_PORT:-18100}`, no build | 448 MiB | dramatiq, one process, 2 threads, queue `default` only |
| `web` | `frontend/Dockerfile`, target `lab` (config `frontend/nginx.lab.conf` baked in) | 96 MiB | nginx: production build of the frontend, `/api/` to the gateway without the prefix; **the only published port** |
| `seed` | `image: openbinding-lab-gateway:${DEMO_LAB_PORT:-18100}`, no build | 384 MiB | `profiles: ["seed"]`; not started by `up` |
| `e2e` | `frontend/Dockerfile.e2e` (`mcr.microsoft.com/playwright:v1.62.1-jammy`, the version `pnpm-lock.yaml` resolves for `@playwright/test`) | 576 MiB | `user: pwuser`, volume `lab-e2e` on `/results`; runs the live specs when `DEMO_E2E=1`, then stays alive; healthy when `/results/done` exists |

**Memory sum of all `mem_limit`: 3776 MiB** (3.6875 GiB; lab ceiling 4096 MiB,
320 MiB to spare).
It includes `seed`, which only runs on demand,
so the steady state is 3392 MiB. `test_lab_compose.py` and
`test_container_hardening.py` recompute the sum and fail if it is not 3776 or
if this document does not state it. `mem_limit` bounds the container, not the
page cache of the named volumes, and image builds are not limited by it.

Optional: the pricing profile `compose.lab-pricing.json` is a 96 MiB one-shot against the remote SPACE, a separate
project outside this 3776 MiB sum; see [qa/PRICING_PROFILE.md](qa/PRICING_PROFILE.md).

**Unprivileged containers.** The gateway image (`gateway`, `worker`, `seed`) runs as
UID/GID 10001 with no login shell. Root inside a rootless
container is not root on the host, but the unprivileged user is still the practice
that limits a compromised process. Consequences for the lab:

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
- The gateway `Dockerfile` installs exactly the lock: `uv export --frozen` of
  `openbinding-gateway/uv.lock`, then `uv pip install --system --require-hashes`
  (`test_the_image_installs_exactly_the_lock_with_hashes`). `bim-core` and `bim-client` 0.2.0
  are the wheels of the GitHub Release `v0.2.0` of
  [`javiercavlop/bim-toolchain`](https://github.com/javiercavlop/bim-toolchain), pinned in the lock
  by SHA-256 (the `bim-core` wheel carries the five OMG BPMN XSDs), and downloaded during the
  build by `tools/fetch_bim_toolchain.py --wheels`. While that repository is private the download
  needs a token that can read it: `compose.lab.json` declares the build
  secret `bim_toolchain_token`, taken from the environment variable `BIM_TOOLCHAIN_TOKEN` and
  mounted only for that `RUN` (it never reaches a layer), so **`BIM_TOOLCHAIN_TOKEN` must be
  exported when the lab is built** (`lab_compose up`).
  `test_container_hardening.py` requires that no service runs as root, that
  `artifacts-init` does not exist, and that the image directory is owned by 10001.
- The image build and `up` with the new ownership were first covered by static checks only (no Docker in the authoring
  environment). They have been run since by the supervisor's `lab_compose`: the stack was up for the smoke (9/9) and for
  Playwright (30/0/0) at `b2780381`. A separate check of the ownership of `lab-artifacts-2` is not recorded in this document.

Compared with `docker-compose.yml`: a single `worker` consumes the `default`
queue only (as in the stack); the
`engine-multi-heuristic` example, adminer, qacobench and the dev profile are
left out; there is no TLS and no examples alias (the frontend reads examples
through `/v1/examples`).

## Variables

The supervisor supplies these. All values below are **synthetic examples, not
secrets**; use your own. The build also needs `BIM_TOOLCHAIN_TOKEN` (see "Unprivileged
containers"), a real token, not a service variable: a fine-grained token with read-only
Contents access to `javiercavlop/bim-toolchain`.

| Variable | Used by | Example |
| --- | --- | --- |
| `DEMO_PG_PASSWORD` | postgres, gateway, worker, seed | `lab-example-pg-password` (letters, digits, `-`, `_`, `.` only: it is embedded in a URL) |
| `DEMO_JWT_SECRET` | gateway **only** (as `GATEWAY_JWT_SECRET`) | `lab-example-jwt-signing-value` (make it long and random) |
| `DEMO_FERNET_KEY` | gateway, worker, seed (as `FEDERATION_SECRET_KEY`, the name `core/settings.py` reads) | a Fernet key: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `DEMO_SPACE_ENABLED` | gateway, worker, seed (as `SPACE_ENABLED`) | `false` or `true`; see "SPACE status" below. `false` is the functional demo without SPACE plans; `true` needs a SPACE development service and contracts |
| `DEMO_SPACE_PRICING_VERSION` | gateway, worker, seed (as `SPACE_PRICING_VERSION`); seed also as `SPACE_DEV_PRICING_VERSION` | `0.1.0` (must exist in SPACE/SPHERE) |
| `DEMO_SPACE_DEFAULT_PLAN` | gateway, worker, seed (as `SPACE_DEFAULT_PLAN`) | `BASIC` (must exist in the pricing) |
| `DEMO_SPACE_DEV_SERVICE` | gateway, worker and seed (as `SPACE_SERVICE_NAME`); seed also as `SPACE_DEV_SERVICE_NAME` | the name of a SPACE *development* service that exists in SPACE (for example `openbinding-dev`); the gateway and worker read and write contracts only on it, and `seed_lab.py --space-contracts` refuses `openbinding` (and any production name) and requires it to equal `SPACE_SERVICE_NAME` |
| `DEMO_SPACE_DEV_PLAN` | seed **only** (as `SPACE_DEV_PLAN`) | a plan of that service's pricing version, for the contracts of the synthetic users |
| `DEMO_SEED_TOOL` | seed | `seed_lab.py`, or `smoke_lab.py` for the API smoke (a file of `openbinding-gateway/tools/`; `seed_dev.py` also exists; `cancel_probe.py` and `diagnose_snapshots.py` were run the same way, see [qa/ENGINE_CANCELLATION_E2E.md](qa/ENGINE_CANCELLATION_E2E.md) and [qa/SNAPSHOT_INVALID_INSTANCE.md](qa/SNAPSHOT_INVALID_INSTANCE.md)) |
| `DEMO_SEED_ARGS` | seed | `--verbose` for a seed, `--with-space` for the smoke (see "Seeding" and "API smoke") |
| `DEMO_SEED_PASSWORD` | seed (`seed_lab.py`, `smoke_lab.py`) and e2e (the live specs sign the synthetic users in with it) | any synthetic value of 10+ characters; the supervisor injects it; `compose.lab.json` passes it only to `seed` and `e2e`, as `${DEMO_SEED_PASSWORD}` with no value and no default |
| `DEMO_E2E` | e2e | `1` runs the live specs when the service starts; anything else (`0`, unset) only creates `/results/done` and sleeps. See "Browser specs and visual QA inside the lab" |
| `DEMO_PUBLIC_ORIGIN` | gateway, worker (`PUBLIC_BASE_URL` only), seed | optional; default `http://localhost:18100`. The origin the browser reaches the lab by, with no trailing slash (for example `https://demo.example.org`). It becomes `PUBLIC_BASE_URL` and `FRONTEND_URL` (the worker gets only `PUBLIC_BASE_URL`) and is appended to `CORS_ALLOW_ORIGINS` after `http://localhost:${DEMO_LAB_PORT:-18100},http://127.0.0.1:${DEMO_LAB_PORT:-18100}`. Unset or empty, the URLs stay `http://localhost:18100` and the list gains an empty item that `Settings.cors_origin_list` discards, so CORS allows only the two local origins. The published port is `127.0.0.1:${DEMO_LAB_PORT:-18100}` |
| `DEMO_LAB_PORT` | `web` (published port), gateway, worker, seed (image tag and local CORS origins) | optional; default `18100` (the develop lab); PR previews use 18101-18199. The loopback port `web` publishes (`127.0.0.1:<port>`). It also sets the gateway image tag `openbinding-lab-gateway:<port>` and the local CORS origins `http://localhost:<port>,http://127.0.0.1:<port>`. The `DEMO_PUBLIC_ORIGIN` defaults keep `http://localhost:18100` |
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
  intended fail-closed behaviour).

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
`CORS_ALLOW_ORIGINS=http://localhost:${DEMO_LAB_PORT:-18100},http://127.0.0.1:${DEMO_LAB_PORT:-18100}`
(plus `DEMO_PUBLIC_ORIGIN`),
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

BIM runs in process in `gateway`, `worker` and `seed` (`bim_client`'s
`InProcessBim`, the default): the lab has no `bim-service` container, no `BIM_*`
variable and no token file (`test_the_lab_runs_bim_in_process` in
`lab/tests/test_lab_compose.py`). The HTTP `bim-service` is a separate deployable of
the toolchain repository
([`SERVICE.md`](https://github.com/javiercavlop/bim-toolchain/blob/v0.2.0/docs/SERVICE.md)).

## Running it with lab_compose

The controller tools that exist for the lab (named here; their arguments are those of the tool descriptions, which this
document does not copy): `lab_compose` with `validate`, `up`, `seed`, `down`, `status`, `metrics`, `logs`, `cleanup`, `archive`
and `result`; `lab_report`; `lab_screenshot` (lists and returns the PNG/JPEG/WebP images of the `lab-e2e` volume, for instance
`screenshots/_summary.png`); `anonymous_http` (`GET` and `HEAD` to the official SPHERE origin); and `archive_worktrees`. `metrics` gives the memory figures, `oom_kill` and the number of pids.

**The `environment` argument of `lab_compose` is a PATCH (merge) over the stored variables.** Omitted or `{}` keeps all of them,
only the keys sent explicitly are replaced, and `validate` uses the same semantics. (Before, an `environment` replaced the whole
stored set and a partial one lost the other variables; that caused a PostgreSQL role reset incident, and it is
no longer the behaviour.) What `seed` does with the saved environment is described in step 3 below (that text predates this
change and was not re-verified).

1. `validate` the file. Expect no complaint; if it refuses something, the
   message is the rule to adapt `compose.lab.json` to.
2. `up`: `docker compose up --detach --build --wait`. The first build compiles
   three Maven projects, installs the frontend with pnpm and several Python
   images; it needs network access to Maven Central, npm, PyPI, the Debian
   archive and GitHub (the release wheels of the BIM toolchain, with
   `BIM_TOOLCHAIN_TOKEN` exported), and takes a long time. `--wait` returns when every healthcheck is
   green; start periods are 60 s for the gateway and the engines.
3. `seed`: `docker compose run --rm --no-deps seed`. Runs
   `python tools/${DEMO_SEED_TOOL} ${DEMO_SEED_ARGS}` in the gateway image with
   the gateway's environment (minus the session secret; see below).
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
(for example, it cannot write a manifest into `tools/`).

`seed_dev.py` creates its users directly in the database; it does not call the
API. For that reason `seed` does not get `GATEWAY_JWT_SECRET`: a tool that logs
in over HTTP sends a password and receives a token signed by the gateway, so it
never needs the secret, and keeping the secret in one service is the point of
`tests/test_compose_worker_secrets.py`.
If a later seed tool needs it, change `SEED_OMITS` in
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
  `lab_screenshot` (for instance `screenshots/_summary.png`, the summary image that `run.sh` renders).

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
(`DEMO_SEED_ARGS='--space-contracts'`).

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
not cover (browser, Playwright, the visual mobile/desktop check) is
left to the live Playwright run.

**Run of 2026-10-13, SHA `5aebc7c8` (`DEMO_SPACE_ENABLED=false`, without
`--with-space`): 9/9 steps passed in 24.4 s.** The later run at `b2780381` also gave 9/9 (duration not
recorded in this document), and so did the run at `c2d46151` in 6.0 s. All three ran with the removed `bim-service`
container. `plan_usage` needs `--with-space`
and was omitted on 2026-10-13 (**not executed**); whether it was run at `b2780381` is not recorded here. Whether it was run at `c2d46151` is not recorded here either.

History: the first complete run passed 8 of 9 steps. The failing one,
`authorization` ("viewer cannot launch"), had a wrong expectation in the smoke:
`POST /v1/jobs` is personal work, so a viewer can launch on their own snapshot
(the expectation was corrected, as described in the table above). Since then a VIEWER
may no longer launch work (`test_viewer_read_only.py`). An earlier attempt had been
blocked by SPACE having no contracts (503 `pricing_unavailable`) and by a job
body without `optimization` (422, fixed).

## Mobile and desktop check

The measurable part is automated: `e2e/live/visual-qa.spec.ts` (see above) checks horizontal overflow, console and page errors, 5xx
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
4. **Migrations.** `logs gateway` should show `Applying database migrations...`
   before uvicorn starts; `worker` starts only after the gateway is healthy.
5. **Memory.** `docker stats --no-stream`: the JVMs at 320 MiB and
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
  else to stay under 4096 MiB (the current total, 3776 MiB, leaves 320 MiB).
- A single worker serves the `default` queue with two threads; concurrent jobs
  can delay each other.
- `gateway`, `worker` and `seed` share one image, `openbinding-lab-gateway:${DEMO_LAB_PORT:-18100}`
  (`openbinding-lab-gateway:18100` by default; a lab that only holds `:latest` builds `:18100` once on its next `up --build`),
  built only by `gateway`. Reason: `up --build` rebuilds only services without a
  profile, and `run --rm --no-deps seed` reuses an existing image without
  rebuilding it, so a `seed` with its own `build` ran code from an earlier build
  (missing new modules and migrations). With the shared tag, every `up` refreshes
  the image the seed runs; `worker` keeps `depends_on: gateway` healthy so the
  image exists before it starts.
- The gateway `Dockerfile` pins uv (0.8.22) and installs the lock with hashes, but its base
  image (`python:3.11-slim`) is a tag and the Debian packages are not pinned, so the image
  is not byte-for-byte reproducible.
- No TLS, no backups of the volumes, one host.
