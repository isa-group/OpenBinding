# PostgreSQL concurrency harness

`openbinding-gateway/tests/concurrency/*_pg.py` test row locks, `SKIP LOCKED`
and partial unique indexes, which SQLite does not exercise. Without
`TEST_DATABASE_URL` they are skipped.

**Status: executed on a real PostgreSQL 16 on 2026-10-13, at SHA `5aebc7c8`.**
Run with `lab_compose` (`compose.pgtest.json`,
`DEMO_PYTEST_ARGS='-rfE --tb=short tests/concurrency'`): **45 passed, 26
skipped** in 11 s. The passing tests cover leases, job publication, idempotency,
study cancellation, sweep versus cancellation, study cells and a two-session
smoke test. The 26 skipped tests are all in `test_pg_harness.py`; see
[Why 26 tests are skipped](#why-26-tests-are-skipped). `lab_compose` accepted the file. Only that one run
is recorded: no repeat runs, no timing statistics, no run on another SHA.

## Running

### lab_compose

Submit `compose.pgtest.json` (repository root) as the Compose file. The
supervisor's `up` starts `postgres` and `image-builder`; the tests run as the `seed` service
(`docker compose run --rm --no-deps seed`), the same pattern as
`compose.lab.json`:

- `postgres`: `postgres:16-alpine`, running as `user: "70:70"` (every capability
  is dropped, so the root entrypoint cannot `chown`), `PGDATA` the `pgdata`
  subdirectory of the data directory, data in a `tmpfs` volume
  (`{"type": "tmpfs", "target": ..., "tmpfs": {"mode": 1023, "size": 167772160}}`:
  1023 is `0o1777` in decimal, so the non-root user can write; 160 MiB), database
  `test_openbinding`, synthetic user/password valid only for this ephemeral
  database, healthcheck `pg_isready`, `mem_limit` 384m. No profile, so `up`
  starts it and `--wait` returns once it is healthy.
- `image-builder` (no profile, so `up` builds and starts it): builds
  `openbinding-gateway/Dockerfile` with the same context as `gateway-dev` (the
  Dockerfile has no stages, so no `target`) and tags it
  `openbinding-pgtest-gateway:latest`. It does nothing: `entrypoint: []`,
  `user: "65534:65534"`, `sleep 3600`, healthcheck `true`, no ports or mounts,
  `mem_limit` 64m, nothing that needs capabilities. It exists because `up --build`
  rebuilds only services without a profile, while `run --no-deps seed` reuses an
  existing image: a `seed` with its own `build` ran stale code (missing new
  modules and migrations). Sharing the image makes every `up` refresh it.
- `seed` (`profiles: ["seed"]`, so `up` does not start it): `image:
  openbinding-pgtest-gateway:latest`, no `build`. It runs `alembic upgrade head`,
  then `pytest -p no:cacheprovider $DEMO_PYTEST_ARGS`; the container exit
  code is pytest's. The arguments come from the `DEMO_PYTEST_ARGS` variable,
  declared in the service `environment` as `"${DEMO_PYTEST_ARGS}"` (Compose
  fills it from the supervisor) and written `$$DEMO_PYTEST_ARGS` in the command
  so the container shell expands and word-splits it, not Compose. The variable
  must be set. Recommended default: `-rfE --tb=short tests/concurrency`. `mem_limit` 768m. It keeps `depends_on: postgres:
  service_healthy` for a plain `run`; with `--no-deps` the wait is done by `up`.

Format rules of lab_compose that the file follows (checked by
`test_pg_harness.py`, without Docker):

- No top-level `networks` or `volumes` (they would only admit `labels`), no
  `networks` on services: all services use the Compose-managed default network
  of the project. No ports are published, no `network_mode`.
- Service names (and volume/network names, if any) match
  `^[a-z][a-z0-9-]{0,62}$`: no underscores.
- Every `volumes` entry is a structured object `{type, source, target}`; only
  `type` and `target` are required by the validator, the rest (such as the
  `tmpfs` options) is passed to Compose (no
  `a:b:ro` strings, no service-level `tmpfs` key). Bind sources are literal
  relative paths inside the repository, without `${`; lab_compose mounts them
  read-only.
- None of `container_name`, `env_file`, `secrets`, `configs`, `cap_add`,
  `privileged`, `deploy`, `extends`. `mem_limit` is an integer with `m` or `g`;
  the limits sum to 1216 MiB (lab ceiling: 4 GiB, harness test: 1.5 GiB).

Mounts: the runner image already contains `src`, `alembic`, `alembic.ini`,
`schemas`, `examples` and `space/pricing/openbinding.yml` (see the Dockerfile),
but not the tests, so the only mount is `./openbinding-gateway/tests` on
`/app/tests` (bind, read-only); the image is enough otherwise (no further mount
or image change was needed in the 2026-10-13 run). The earlier mounts of the whole source tree
and of `docs`, `engines`, `pricings` and `space` are gone: nothing in
`tests/concurrency` reads `docs`, `engines` or `pricings`, and binds are always
read-only, so nested mounts below a mounted `/app` could not create their mount
points. lab_compose accepted the bind in the 2026-10-13 run. The postgres data directory is a `tmpfs` volume of 160 MiB,
inside the 384m container limit.

`space/` dependency: `tests/concurrency/test_job_leases_pg.py` reads the pricing
catalogue through `tests/_pricing.py`, which finds `/app/space/pricing/openbinding.yml`
inside the image (copied by `Dockerfile` line `COPY space/pricing/openbinding.yml`).
When `space/` is removed, that `COPY` and `_pricing.py`/`pricing_catalog.py`
candidate paths must be updated, or the image build and this test fail.

### Local

```sh
sh tools/test_pg.sh
```

Needs Docker with the compose plugin. It is the supervisor's flow:
`docker compose -f compose.pgtest.json up --detach --wait postgres`, then
`run --rm --no-deps seed` (the script's exit code is pytest's; set
`DEMO_PYTEST_ARGS`, e.g. `-rfE --tb=short tests/concurrency`), then `down
--volumes` (the data is in a tmpfs; no named volume exists).

Against your own server instead:

```sh
cd openbinding-gateway
TEST_DATABASE_URL=postgresql+asyncpg://USER:PASS@HOST/test_something \
  pytest -p no:cacheprovider -rfE --tb=short tests/concurrency
```

## Safety guard

If `TEST_DATABASE_URL` is **unset** the `two_sessions` fixture skips. If it is
set (even empty) and the dialect is not PostgreSQL or the database name does
not start with `test`, the test **fails**: the fixture truncates every table.

Schema setup uses Alembic (`upgrade head`, through the connection, so `env.py`
needs no `DATABASE_URL`), not `create_all`. Between tests all tables except
`alembic_version` are truncated (`TRUNCATE ... RESTART IDENTITY CASCADE`).
`TRUNCATE` does not fire the row-level "retained history" delete triggers.

Do not point other suites (`db_session` in `tests/conftest.py`) at this URL:
that fixture still uses `drop_all/create_all` and would remove the migrated
schema.

## Why 26 tests are skipped

Read from the code on 2026-10-13 (the run's output was not kept, and `-rfE` does not
list skips, so this is derived, not observed).

- `openbinding-gateway/tests/concurrency/test_pg_harness.py:46-50`: the module
  fixture `compose` calls `pytest.skip(f"compose.pgtest.json not found under
  {REPO_ROOT}")` (line 49) when `REPO_ROOT / "compose.pgtest.json"` (line 19) is not
  a file.
- `REPO_ROOT` comes from `openbinding-gateway/tests/_repo.py:9-21`: the first of
  `parents[2]`, `parents[1]` of the test file that contains `schemas/bim/v1` and
  `examples`. Inside the `seed` container the tests are mounted at `/app/tests`
  (`compose.pgtest.json:80-81`) and the image carries `schemas` and `examples` but
  not `compose.pgtest.json`, so `REPO_ROOT` resolves to `/app` and the file is
  absent.
- Tests that request `compose`: 18 plain tests plus `test_compose_services_use_no_forbidden_key`
  (line 156-157), parametrized over 8 keys. 18 + 8 = **26**, which matches the
  count. The remaining 15 tests of the file (the URL guard, lines 53-108) do not
  use `compose` and passed. `test_seed_uses_the_gateway_dockerfile` also has its own
  skip (line 236-237, no `docker-compose.yml`), which is never reached here.

So the skips are not the `TEST_DATABASE_URL` guard: the variable was set and valid
(the other 45 tests used PostgreSQL). They are the static checks of the shape of
`compose.pgtest.json`, which need a repository checkout.

Coverage gap: none of the PostgreSQL behaviour is hidden. But these 26 checks do
**not run in the lab PostgreSQL run**; they run only in an ordinary checkout. Whether
they pass in a checkout at this SHA was **not measured here**; this update did not
run `tests/concurrency`. To run them in the lab run, mount `compose.pgtest.json`
(or set `OPENBINDING_REPO_ROOT` to a tree that has it): pending.

## What it validates

Observed passing on 2026-10-13 (see Status). Covers:

- `SELECT ... FOR UPDATE [SKIP LOCKED]` behaviour of job claims and sweeps.
- Concurrent launches of one study cell and `(owner_id, idempotency_key)`
  idempotency, against the real partial unique indexes from the migrations
  (`uq_jobs_study_cell_id`).
- That the migration chain applies cleanly to an empty PostgreSQL 16.

## What it does not validate

- Model/migration drift (no autogenerate comparison).
- Upgrade from older schema revisions with data.
- Any other test suite on PostgreSQL, the HTTP API, engines, Redis, SPACE.
- Behaviour under PostgreSQL settings differing from the test ones
  (`fsync=off`, small `shared_buffers`), or at scale.

## Open points after the first run

The earlier "expected failures" did not occur in the 2026-10-13 run (the bind
mount and the structured `tmpfs` volume were accepted, seed data inserted, the
postgres data directory started). What remains unknown:

- Whether the skip reason given below is exactly what happened: it is derived from
  the code, and the run used `-rfE`, which does not print skip reasons (`-rs`).
- Timing assertions (`wait_for(..., timeout=10)`, `sleep(0.2/0.5)`) on a loaded
  host: the run took 11 s on one host; no other load was measured.
- `tmpfs` ownership for the postgres data directory on other runtimes (mitigated
  by mode `1777`, `user: 70:70` and `PGDATA` in a subdirectory).

## Recommended CI job (not added; `ci.yml` is out of scope here)

```yaml
  pg-concurrency:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: sh tools/test_pg.sh
```

Run it on pull requests touching `openbinding-gateway/**` or
`compose.pgtest.json`, and make it required once it has been green.
