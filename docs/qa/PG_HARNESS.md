# PostgreSQL concurrency harness

`openbinding-gateway/tests/concurrency/*_pg.py` test row locks, `SKIP LOCKED`
and partial unique indexes, which SQLite does not exercise. Without
`TEST_DATABASE_URL` they are skipped.

**Status: these tests have not been executed by the author of this harness.**
The authoring environment had no Docker and no PostgreSQL. Expect the first
real run to surface failures (see "Expected failures"). Only the checks in
`test_pg_harness.py` (URL guard, shape of `compose.pgtest.json`) have run.

## Running

### lab_compose

Submit `compose.pgtest.json` (repository root) as the Compose file. It starts:

- `postgres`: `postgres:16-alpine`, data in tmpfs, database `test_openbinding`,
  synthetic user/password valid only for this ephemeral database, healthcheck
  `pg_isready`, `mem_limit` 384m.
- `runner`: built from `openbinding-gateway/Dockerfile` with the same context as
  `gateway-dev` (the Dockerfile has no stages, so no `target`). It waits for
  `postgres` to be healthy, runs `alembic upgrade head`, then
  `pytest -p no:cacheprovider -rA tests/concurrency`; the container exit code is
  pytest's. `mem_limit` 768m.

No ports are published; both services share one `internal` network. Limits sum
to 1152 MiB. The image does not contain the tests, so (like `gateway-dev`) the
runner bind-mounts the source read-only: `./openbinding-gateway` on `/app` plus
`schemas`, `examples`, `docs`, `engines`, `pricings`, `space`. If lab_compose
rejects bind mounts, the tests need to be baked into an image instead.

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

- `lab_compose` rejecting the bind mounts (see above).
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
