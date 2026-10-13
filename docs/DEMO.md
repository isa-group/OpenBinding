# OpenBinding lab demo (Docker)

`compose.lab.json` (repository root) starts a self-contained OpenBinding/BIM
demo on one lab host. It is reached from a Mac through an SSH tunnel; the only
thing published on the host is `127.0.0.1:18100`.

**Status: first real start done on 2026-10-13.** With `lab_compose up` every
service became healthy; the seed and the API smoke were run (results under
"Seeding", "API smoke" and "Known limits"). **Not executed**: Playwright against
the live lab, the mobile/desktop visual check, the PostgreSQL concurrency run at
this SHA, and the lab with `DEMO_SPACE_ENABLED=true` and real contracts (SPACE
has no service or contracts, see "SPACE status"). The lab currently runs with
`DEMO_SPACE_ENABLED=false`: an open development gate with no real entitlements.
A static check also exists (`lab/tests/test_lab_compose.py`).

## What runs

| Service | Image / build | `mem_limit` | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | 384 MiB | volume `lab-pg`, `PGDATA=/var/lib/postgresql/data/pgdata`, `pg_isready` healthcheck, `user: 70:70` |
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

**Memory sum of all `mem_limit`: 3456 MiB** (3.375 GiB; lab ceiling 4096 MiB,
target 3481 MiB = 3.4 GiB). It includes `seed`, which only runs on demand, so
the steady state is 3072 MiB. `test_lab_compose.py` recomputes the sum and fails
if this document does not state it. `mem_limit` bounds the container, not the
page cache of the named volumes, and image builds are not limited by it.

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
| `DEMO_SEED_TOOL` | seed | `seed_lab.py`, or `smoke_lab.py` for the API smoke (a file of `openbinding-gateway/tools/`; `seed_dev.py` also exists) |
| `DEMO_SEED_ARGS` | seed | `--verbose` for a seed, `--with-space` for the smoke (see "Seeding" and "API smoke") |
| `DEMO_SEED_PASSWORD` | seed (`seed_lab.py`, `smoke_lab.py`) | any synthetic value of 10+ characters; the supervisor injects it; `compose.lab.json` passes it only to `seed`, as `${DEMO_SEED_PASSWORD}` with no value and no default |
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

BIM variables (`BIM_MODE=http`, `BIM_SERVICE_URL=http://bim-service:8080`,
`BIM_SERVICE_TOKEN_FILE=/run/bim/token`) are defined on the gateway, and its
start command writes the file from `DEMO_BIM_TOKEN` into a tmpfs
(`umask 077`). **Nothing in the gateway reads them yet**; a later phase will.

`BIM_SERVICE_ALLOW_INSECURE_HTTP=true` is set only on `gateway`, `worker` and
`seed`. The service is reached over plain `http` inside the lab's private Docker
network with a synthetic token, and `bim_client` refuses a bearer token over
plain `http` to a non-loopback host unless that is opted into explicitly. The
gateway logs a warning at startup. Do not copy this to a real deployment.

## Running it with lab_compose

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
   (`lab-pg`, `lab-redis`, `lab-artifacts`), so data survives a restart. Only
   an explicit volume removal deletes it.

### Seeding

The image does not contain `tools/`, so `seed` bind-mounts
`./openbinding-gateway/tools` on `/app/tools`, read-only (all binds are). Two
consequences: a tool cannot write beside itself (`seed_dev.py` writes
`tools/analysis-manifest.json` by default; pass
`--analysis-manifest /tmp/analysis-manifest.json` when you use the analysis
options), and the seed runs the code of the checkout, not of the image. Add
`COPY openbinding-gateway/tools/ tools/` to the Dockerfile to remove the bind.

`seed_dev.py` creates its users directly in the database; it does not call the
API. For that reason `seed` does not get `GATEWAY_JWT_SECRET`: a tool that logs
in over HTTP sends a password and receives a token signed by the gateway, so it
never needs the secret, and keeping the secret in one service is the point of
`tests/test_compose_worker_secrets.py`. The seed also gets no BIM variables.
If a later seed tool needs either, change `SEED_OMITS` in
`lab/tests/test_lab_compose.py` together with the compose file.

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

**First complete run (2026-10-13, `DEMO_SPACE_ENABLED=false`, without
`--with-space`): 8 of 9 steps passed.** Passed: `proxy_and_spa`, `login`,
`owner_job` (a real `random-search` job with the gateway's authoritative
reevaluation), `idempotency`, `concurrency_limit` (429), `cors`, `body_limit` and
`login_throttle`. The ninth, `authorization` ("viewer cannot launch"), failed
because of a wrong expectation in the smoke: `POST /v1/jobs` is personal work, so
a viewer can launch on their own snapshot. The expectation is corrected in
`smoke_lab.py` (as described in the table above); that corrected step has not
been re-run since in a full run recorded here. `plan_usage` needs `--with-space`
and was **not executed**. An earlier attempt had been blocked by SPACE having no
contracts (503 `pricing_unavailable`) and by a job body without `optimization`
(422, fixed).

## Mobile and desktop check

In the browser on the Mac (DevTools, device toolbar):

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
   which Kubernetes uses, is unchanged. An earlier version bind-mounted
   `lab/nginx`; with rootless docker and an extracted, read-only copy of the
   tree that directory could be empty or unreadable for uid 101, so nginx
   started its workers with no `server` block: nothing listened on 80 or 8080
   (`Connection refused`) and the healthcheck failed. If `web` is unhealthy
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
3. **Artifacts.** `lab-artifacts` is written by `gateway`, `worker` and
   `seed`, all root in their containers; check that a job produces a
   downloadable artifact. Root needs no capability for this: the volume is
   created root-owned, and uvicorn listens on 8000, `alembic` and the seed
   tools only read the image and write the database and this volume.
   `docker-entrypoint.sh` does no `chown`. The seed reads the bind-mounted
   `tools/` as "other", so those files must be world-readable (the default).
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
- Not executed: Playwright against the live lab, the mobile/desktop visual check,
  the PostgreSQL concurrency run at this SHA, and SPACE enabled with real
  contracts (SPACE has no service or contracts and rejects the pricing
  `createdAt` format; see "SPACE status"). `DEMO_SPACE_ENABLED=false` gives no
  real entitlements.
- `lab_compose seed` ignores the environment passed to it and uses the one saved
  by the last `up`.
- The proxy-header trust list covers the three private ranges Docker allocates
  networks from, because the address of `web` is not known in advance. The
  gateway is only reachable from the compose network, so those are its only
  possible peers.
- `engine-minizinc` at 192 MiB runs Node plus MiniZinc and its solver as child
  processes; a large model may not fit. Raising it means lowering something
  else to stay under 3481 MiB (the current total leaves 25 MiB).
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
