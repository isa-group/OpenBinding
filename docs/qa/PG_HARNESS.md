# PostgreSQL concurrency harness

`openbinding-gateway/tests/concurrency/*_pg.py` test row locks, `SKIP LOCKED`
and partial unique indexes, which SQLite does not exercise. Without
`TEST_DATABASE_URL` they are skipped.

**Status: these tests have not been executed by the author of this harness.**
The authoring environment had no Docker and no PostgreSQL. Expect the first
real run to surface failures (see "Expected failures"). Only the checks in
`test_pg_harness.py` (URL guard, shape of `compose.pgtest.json`) have run. The
file has not been accepted by lab_compose after the last change either.

## Running

### lab_compose

Submit `compose.pgtest.json` (repository root) as the Compose file. It starts:

- `postgres`: `postgres:16-alpine`, data in a `tmpfs` volume, database
  `test_openbinding`, synthetic user/password valid only for this ephemeral
  database, healthcheck `pg_isready`, `mem_limit` 384m.
- `runner`: built from `openbinding-gateway/Dockerfile` with the same context as
  `gateway-dev` (the Dockerfile has no stages, so no `target`). It waits for
  `postgres` to be healthy, runs `alembic upgrade head`, then
  `pytest -p no:cacheprovider -rA tests/concurrency`; the container exit code is
  pytest's. `mem_limit` 768m.

Format rules of lab_compose that the file follows (checked by
`test_pg_harness.py`, without Docker):

- No top-level `networks` or `volumes` (they would only admit `labels`), no
  `networks` on services: both services use the Compose-managed default network
  of the project. No ports are published, no `network_mode`.
- Every `volumes` entry is a structured object `{type, source, target}` (no
  `a:b:ro` strings, no service-level `tmpfs` key). Bind sources are literal
  relative paths inside the repository, without `${`; lab_compose mounts them
  read-only.
- None of `container_name`, `env_file`, `secrets`, `configs`, `cap_add`,
  `privileged`, `deploy`, `extends`. `mem_limit` is an integer with `m` or `g`;
  the limits sum to 1152 MiB (lab ceiling: 4 GiB, harness test: 1.5 GiB).

Mounts: the runner image already contains `src`, `alembic`, `alembic.ini`,
`schemas`, `examples` and `space/pricing/openbinding.yml` (see the Dockerfile),
but not the tests, so the only mount is `./openbinding-gateway/tests` on
`/app/tests` (bind, read-only). The earlier mounts of the whole source tree
and of `docs`, `engines`, `pricings` and `space` are gone: nothing in
`tests/concurrency` reads `docs`, `engines` or `pricings`, and binds are always
read-only, so nested mounts below a mounted `/app` could not create their mount
points. If lab_compose rejects the bind, the tests need to be baked into an
image instead. The postgres data directory is a `tmpfs` volume without an
explicit size (the structured form carries none); it is bounded by the 384m
container limit.

`space/` dependency: `tests/concurrency/test_job_leases_pg.py` reads the pricing
catalogue through `tests/_pricing.py`, which finds `/app/space/pricing/openbinding.yml`
inside the image (copied by `Dockerfile` line `COPY space/pricing/openbinding.yml`).
When `space/` is removed, that `COPY` and `_pricing.py`/`pricing_catalog.py`
candidate paths must be updated, or the image build and this test fail.

### Local

```sh
sh tools/test_pg.sh
```

Needs Docker with the compose plugin. It runs `compose.pgtest.json` with
`--exit-code-from runner` and removes containers and volumes afterwards.

Against your own server instead:

```sh
cd openbinding-gateway
TEST_DATABASE_URL=postgresql+asyncpg://USER:PASS@HOST/test_something \
  pytest -p no:cacheprovider -rA tests/concurrency
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

## What it validates

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

## Expected failures on first run

- `lab_compose` rejecting the bind mount of the tests (see above), or the
  structured `tmpfs` volume without a `source`.
- Seed data hitting a NOT NULL or trigger the tests never met on SQLite. Already
  fixed from reading the models: `Blob.created_by_id`, and setting
  `source_snapshot_id` / `engine_ref` at INSERT (migration triggers forbid
  updating them on `binding_case_revisions` and `study_cells`).
- Timing assertions (`wait_for(..., timeout=10)`, `sleep(0.2/0.5)`) on a loaded host.
- `tmpfs` ownership for the postgres data directory on some runtimes.

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
