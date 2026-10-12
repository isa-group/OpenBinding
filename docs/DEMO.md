# OpenBinding lab demo (Docker)

`compose.lab.json` (repository root) starts a self-contained OpenBinding/BIM
demo on one lab host. It is reached from a Mac through an SSH tunnel; the only
thing published on the host is `127.0.0.1:18100`.

**Status: nothing in this file has been run.** The file was written without a
Docker daemon. What exists is a static check without Docker
(`lab/tests/test_lab_compose.py`); every image build, every healthcheck, the
user/permission settings and the whole startup order are untested. Read
"Known limits" before the first start.

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
| `gateway` | `openbinding-gateway/Dockerfile` | 640 MiB | `alembic upgrade head` through the image entrypoint, then uvicorn with `--proxy-headers` |
| `worker` | same image | 448 MiB | dramatiq, one process, 2 threads, queues `default` and `analysis` |
| `web` | `frontend/Dockerfile`, target `prod` | 96 MiB | nginx: production build of the frontend, `/api/` to the gateway without the prefix; **the only published port** |
| `seed` | same image as `gateway` | 384 MiB | `profiles: ["seed"]`; not started by `up` |

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
| `DEMO_SPACE_PRICING_VERSION` | gateway, worker, seed (as `SPACE_PRICING_VERSION`) | `0.1.0` (must exist in SPACE/SPHERE) |
| `DEMO_SPACE_DEFAULT_PLAN` | gateway, worker, seed (as `SPACE_DEFAULT_PLAN`) | `BASIC` (must exist in the pricing) |
| `DEMO_SEED_TOOL` | seed | `seed_dev.py` (a file of `openbinding-gateway/tools/`; `seed_lab.py` does not exist yet) |
| `DEMO_SEED_ARGS` | seed | `--verbose` (see "Seeding") |

Private, supplied by the supervisor and only referenced as `${NAME}` (the file
holds no value and no default): `SPACE_URL`, `SPACE_API_KEY`, `SPHERE_URL`,
`SPHERE_API_KEY`, `SPHERE_ORGANIZATION_ID`, `SPACE_ORGANIZATION_ID`. The last
one is passed only to `seed`: `core/settings.py` does not read it, but
`tools/remote_probe.py` exits with "SPACE_ORGANIZATION_ID is not set" without
it. The retired
destructive SPACE key is not used anywhere, and no `VITE_*` variable carries a
key (the frontend is built with `VITE_API_BASE_URL=/api` only).

Fixed in the file: `APP_ENV=dev`, `CAS_ENABLED=false`, `SPACE_ENABLED=true`,
`SPHERE_ENABLED=true`, `MAX_CONCURRENT_JOBS_PER_USER=3`,
`CORS_ALLOW_ORIGINS=http://localhost:18100,http://127.0.0.1:18100`,
`PUBLIC_BASE_URL` and `FRONTEND_URL` `http://localhost:18100`.
`FORWARDED_ALLOW_IPS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`.

BIM variables (`BIM_MODE=http`, `BIM_SERVICE_URL=http://bim-service:8080`,
`BIM_SERVICE_TOKEN_FILE=/run/bim/token`) are defined on the gateway, and its
start command writes the file from `DEMO_BIM_TOKEN` into a tmpfs
(`umask 077`). **Nothing in the gateway reads them yet**; a later phase will.

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

To be filled in after `seed_lab` exists. Until then, `seed_dev.py` creates the
development users listed in its own docstring and constants; check
`openbinding-gateway/tools/seed_dev.py` for the names. Do not reuse these
passwords anywhere.

| Role | Username | Password |
| --- | --- | --- |
| _pending_ | _pending_ | _pending_ |

## Mobile and desktop check

In the browser on the Mac (DevTools, device toolbar):

- Mobile: 390 x 844 (iPhone 14 class). Navigate home, login, cases, a job, the
  workbench; check the navigation, tables that scroll horizontally and the
  touch targets.
- Desktop: 1440 x 900.

Reload with the cache disabled after a rebuild: `index.html` is served with
`no-cache`, hashed assets for a year.

## Checks for the first start (not done)

Everything here is a hypothesis until it is observed.

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
   `20-envsubst-on-templates.sh`) try to write `/etc/nginx/conf.d/default.conf`,
   which is the read-only bind mount of `lab/nginx`, so the first real start
   exited with code 1. `lab/nginx/default.conf` is complete by itself. Look at `logs web` for
   `Permission denied`, `setgid`/`setuid`, or `open() "/run/nginx.pid" failed`.
   `curl http://127.0.0.1:18100/healthz` on the lab host must answer `ok`, and
   `/api/health/ready` must answer through the proxy.
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

- Nothing was run: no build, no start, no healthcheck. The static test checks the
  file against the validator's rules as described to me, not against the
  validator itself.
- `user` on `postgres`, `redis` and `web`, the `tmpfs` mounts of `web`, and
  `entrypoint: []` on `worker` are not in the list of keys `lab_compose` is
  known to refuse, but the validator has not been run against this file either.
- The proxy-header trust list covers the three private ranges Docker allocates
  networks from, because the address of `web` is not known in advance. The
  gateway is only reachable from the compose network, so those are its only
  possible peers.
- `engine-minizinc` at 192 MiB runs Node plus MiniZinc and its solver as child
  processes; a large model may not fit. Raising it means lowering something
  else to stay under 3481 MiB (the current total leaves 25 MiB).
- A single worker serves both queues with two threads; analysis jobs and solve
  jobs can delay each other.
- `gateway`, `worker` and `seed` each build the same image (same context and
  Dockerfile); the second and third build should be cache hits.
- `Dockerfile` of the gateway installs `uv` from `ghcr.io/astral-sh/uv:latest`
  and installs packages without the lock file, so the image is not
  reproducible.
- No TLS, no backups of the volumes, one host.
