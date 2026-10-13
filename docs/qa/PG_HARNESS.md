# PostgreSQL concurrency harness

`openbinding-gateway/tests/concurrency/*_pg.py` test row locks, `SKIP LOCKED`
and partial unique indexes, which SQLite does not exercise. Without
`TEST_DATABASE_URL` they are skipped.

**Status: executed on a real PostgreSQL 16 in the lab, at base `d823cd8d`:** `lab_compose`
(`compose.pgtest.json`, `lab_compose up` + `seed`,
`DEMO_PYTEST_ARGS='-rfEs --tb=short --durations=8 tests/concurrency'`) gave
**58 passed, 0 skipped in 12 s**. Per file: `test_job_leases_pg` 9, `test_job_publication_pg` 9,
`test_jobs_idempotency_pg` 1, `test_pg_guard` 1, `test_pg_harness` 15, `test_study_cancel_pg` 5,
`test_study_cells_pg` 3, `test_sweep_vs_cancel_pg` 3, `test_two_sessions_smoke` 1,
`test_watchdog` 11. No repeat runs, no timing statistics.

An earlier run (2026-10-13, SHA `5aebc7c8`) gave 45 passed, 26 skipped: the skips were the
compose-shape tests, which could not find `compose.pgtest.json` inside the image. That was fixed
(see below) and the 58/0 run above is the observation after the fix.

What changed after the earlier run:

- The compose-shape tests moved from `tests/concurrency/test_pg_harness.py` to
  `tests/test_pg_harness.py`, the ordinary gateway suite, where the checkout and the file exist.
  They are not skipped any more (see [Compose-shape tests](#compose-shape-tests)).
- `seed` runs as `user: "0:0"` so it can read the bind-mounted tests (see
  [Why the seed runs as root](#why-the-seed-runs-as-root)).

## Running

### lab_compose

Submit `compose.pgtest.json` (repository root) as the Compose file (`file=compose.pgtest.json`)
with the environment variable `DEMO_PYTEST_ARGS`. The supervisor's `up` starts `postgres` and
`image-builder`; the tests run as the `seed` service (`docker compose run --rm --no-deps seed`),
the same pattern as `compose.lab.json`.

Exact sequence:

1. `lab_compose` with `file=compose.pgtest.json`, action `up` (builds the image, starts
   `postgres`, waits until it is healthy; `seed` is behind a profile and does not start).
2. `lab_compose` with `file=compose.pgtest.json`, running `seed`, with
   `environment: {"DEMO_PYTEST_ARGS": "-rfE --tb=short tests/concurrency"}`. Use `-rsfE`
   instead to print skip reasons. The exit code of the service is pytest's.
3. `lab_compose` with `file=compose.pgtest.json`, `down` (the data is in a tmpfs; nothing to
   remove).

Services:

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
  openbinding-pgtest-gateway:latest`, no `build`, `user: "0:0"`. It runs `alembic upgrade head`,
  then `pytest -p no:cacheprovider $DEMO_PYTEST_ARGS`; the container exit
  code is pytest's. The arguments come from the `DEMO_PYTEST_ARGS` variable,
  declared in the service `environment` as `"${DEMO_PYTEST_ARGS}"` (Compose
  fills it from the supervisor) and written `$$DEMO_PYTEST_ARGS` in the command
  so the container shell expands and word-splits it, not Compose. The variable
  must be set. Recommended default: `-rfE --tb=short tests/concurrency`. `mem_limit` 768m. It keeps `depends_on: postgres:
  service_healthy` for a plain `run`; with `--no-deps` the wait is done by `up`.

Format rules of lab_compose that the file follows (checked by
`openbinding-gateway/tests/test_pg_harness.py`, without Docker):

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
  the limits sum to 1216 MiB (384 + 64 + 768; lab ceiling: 4 GiB, harness test: 1.3 GiB =
  1331 MiB). The `user` change adds no memory.

### Why the seed runs as root

The gateway image ends on `USER 10001:10001`. Under rootless Docker that uid can be refused on a
bind-mounted directory of the host checkout (`Permission denied`, which is how the lab `seed`
failed on `tools/`; that case was fixed by `COPY tools/` into the image). The tests are still
bind-mounted here, so the options were:

1. A test stage in the Dockerfile that copies `tests/` (the lab's own fix). It keeps the
   production image untouched and needs no root, and it is the better long-term answer. It was
   **not done**: `openbinding-gateway/Dockerfile` is outside the file scope of this change.
   Pending, see below.
2. Copy the tests into the production image: rejected, it thickens that image.
3. `user: "0:0"` on `seed` only: chosen. In a rootless container uid 0 is the host user that owns
   the checkout, so the bind is read as its owner, without any capability (the supervisor drops
   them all). The container is ephemeral and tests-only: the bind is read-only, nothing is
   published, there is no `cap_add`, `privileged` or socket, and the only network is the private
   Compose one, where it reaches the test database. `postgres` (70:70) and `image-builder`
   (65534:65534) stay non-root, and `tests/test_pg_harness.py` pins both facts.

Record: the `seed` service runs as container root (`0:0`) of a **rootless** runtime, only in this
ephemeral harness. The pending alternative is a dedicated `test` stage in the Dockerfile.

If the Dockerfile gets a `test` stage, set `target` on `image-builder`, drop the bind mount and
the `user`, and update the tests.

### Mounts

The runner image already contains `src`, `alembic`, `alembic.ini`,
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

## Compose-shape tests

Diagnosis of the 26 skips of the 2026-10-13 run (derived from the code; `-rfE` does not print
skip reasons): the old `compose` fixture in `tests/concurrency/test_pg_harness.py` called
`pytest.skip("compose.pgtest.json not found under ...")` when `REPO_ROOT / "compose.pgtest.json"`
was not a file. In the `seed` container `REPO_ROOT` (`tests/_repo.py`, with
`OPENBINDING_REPO_ROOT=/app`) is `/app`, which has `schemas` and `examples` but not the compose
file. 18 plain tests + 8 for `test_compose_services_use_no_forbidden_key` (one per key) = 26.

Fix: these static checks do not need a database, so they run where the file exists, in the
ordinary gateway suite, instead of mounting the compose file into the container.

- `openbinding-gateway/tests/test_pg_harness.py` holds the shape tests: 28 tests (the 26 plus two
  new ones that pin the seed's single `tests` bind and the root/non-root users).
- A missing `compose.pgtest.json` **fails** them. The only way to skip is the explicit variable
  `OPENBINDING_SKIP_COMPOSE_SHAPE=1`, which also covers the missing `docker-compose.yml` of
  `test_seed_uses_the_gateway_dockerfile`. Nothing in the harness sets it.
- Do not put `tests/test_pg_harness.py` (or the whole `tests`) in `DEMO_PYTEST_ARGS`: the container
  has no checkout, so they would fail by design. The default `tests/concurrency` does not collect them.
- `tests/concurrency/test_pg_harness.py` now holds only the 15 URL-guard tests (they need no
  checkout and run in the container). `tests/concurrency/test_pg_guard.py` asserts that no file
  there skips except through `_two_sessions.py` (missing `TEST_DATABASE_URL`).

## Per-test watchdog

`tests/concurrency/conftest.py` has an autouse fixture that fails any test of the directory that
outlives its limit, so a hang is a diagnosable failure instead of a harness that runs until its
outer timeout and loses the output (a `test_study_cancel_pg.py` run once did exactly that).

- Limit: **60 s** per test, fixture setup and teardown included (the schema upgrade counts). Change
  it with `OPENBINDING_PG_TEST_TIMEOUT` (seconds, a positive number); in the lab put it in the
  environment of the `seed` service next to `DEMO_PYTEST_ARGS`. A malformed or non-positive value is
  an error, not a disabled watchdog.
- Mechanism (`tests/concurrency/_watchdog.py`): `signal.setitimer(ITIMER_REAL)` and a `SIGALRM`
  handler on the main thread that raises `WatchdogTimeout`. For an async test the exception is raised
  from inside the event loop's `select`, so the loop stops and pytest-asyncio (auto mode) reports the
  test as failed; no plugin is needed. After the first expiry the timer repeats every 15 s, so a hang
  in a fixture's teardown is reported as well. It needs SIGALRM and the main thread (not Windows, not
  a worker thread); otherwise it warns and does not protect.
- A test that waits legitimately longer than 60 s needs a higher variable value, not a code change.

### Reading a timeout failure

The failure is `WatchdogTimeout: test exceeded 60 s (OPENBINDING_PG_TEST_TIMEOUT changes the limit)`
followed by:

1. `Threads:` - `faulthandler` stacks of every thread, most recent call first. The main thread
   normally sits in the event loop's `select`; look at the other threads for blocking calls.
2. `asyncio tasks:` - one entry per task of the running loop with its coroutine stack (most recent call
   last). A test's tasks are the `gather`ed coroutines: the line each task is suspended on (`await
   event.wait()`, a `session.execute`, `asyncio.sleep`) says what it waits for. Two tasks both in
   `session.execute`/`lock_run`/`lock_cells` point to a lock cycle or a lock never released (check the
   other session's `commit`); a task in `Event.wait` whose setter is not in the list means the setter
   returned early or raised.

The waits on events in `test_study_cancel_pg.py` go through `_happens(...)`, which fails after 10 s
naming what did not happen, before the watchdog would. `tests/concurrency/test_watchdog.py` tests the
mechanism without a database and without hanging for real (0.2 s limits).

## Study tests need the owner's membership

`study_jobs._sync` launches the next cell only if the run's owner still has MEMBER or more in the
organization; otherwise it fails the waiting cells with `owner_role_revoked`. The `_seed` fixture of
`test_study_cells_pg.py` (shared with `test_study_cancel_pg.py`) therefore creates the
`OrganizationMembership` of the owner (OWNER, as in production, where the creator is a member).
Without it `test_two_concurrent_syncs_launch_the_next_cell_once` saw no launch, and
`test_study_cancel_pg.py::test_a_cancellation_that_waits_for_a_sync_cancels_the_cell_it_launched`
hangs **by reading the code**: its `cancel()` waits on `launching.wait()`, an event set only inside the
launch, which never happens, so `gather` never finishes. That is a test defect, not a production
deadlock; the lock order (run, cells, jobs) is not involved. This is derived from the code, not
observed: the hanging lab run printed nothing. The other tests of the file do not wait on a launch.
`test_two_concurrent_syncs_of_a_demoted_owner_launch_nothing_and_fail_the_cell_once` pins the opposite
behaviour: owner demoted to VIEWER, no cell launched, the cell failed with `owner_role_revoked`, one
audit event.

## Expected results

Observed in the lab at base `d823cd8d` (PostgreSQL 16, `compose.pgtest.json`, `lab_compose up` +
`seed`, `DEMO_PYTEST_ARGS='-rfEs --tb=short --durations=8 tests/concurrency'`):
**58 passed, 0 skipped in 12 s** (files and counts in the Status paragraph at the top). The seed ran as
`0:0` and read the bind without `Permission denied`.

For comparison, the ordinary-suite run (no `TEST_DATABASE_URL`) of
`tests/concurrency tests/test_pg_harness.py ../lab/tests` gave **129 passed, 31 skipped**
(the 31 are the PostgreSQL tests, skipped only for the missing `TEST_DATABASE_URL`; no
compose-shape test is skipped).

- Exit code 0. Any `SKIPPED` in the lab run is a defect (`-rs` prints the reasons).
- If `seed` shows `Permission denied` on `/app/tests`, the `user: "0:0"` did not take effect
  or the runtime refuses even the bind owner: report it, do not add capabilities.

### Tool limitation: the 420 s limit of lab_compose

The `lab_compose` operation has a **420 s limit**. A hung run exhausts it, the output is lost, and
the `seed-run` container is left **orphaned**: no MCP tool stops it. That is why the per-test
watchdog exists (see below). If the suite grows, split it into chunks (several `seed` runs with
different `DEMO_PYTEST_ARGS` paths) so that each stays well under the limit.

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

- Whether the skip reason described under Compose-shape tests is exactly what happened: it
  is derived from the code, and the run used `-rfE`, which does not print skip reasons (`-rs`).
- The Dockerfile `test` stage that would replace `user: "0:0"` (see Why the seed runs as root);
  the root user did read the bind in the lab run.
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
