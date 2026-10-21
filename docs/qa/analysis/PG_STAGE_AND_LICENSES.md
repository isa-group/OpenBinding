# Analysis: a `test` stage for the PostgreSQL harness, and rights inventory of `bim-toolchain/`

Documentary analysis. Nothing was built, run or published; no code, Compose file or Dockerfile was changed. Every
statement below is read from the files named next to it. What could not be verified is marked **NOT VERIFIABLE** or
**NOT OBSERVED** and is not filled in.

Limits of the method: this worker had file read/search tools only (no shell, no `git log`, no `sha256sum`, no
network). So no hash was recomputed, no history was read, no two files were diffed byte by byte, and no licence text
was fetched from any website.

Contents:

1. [Part 1: non-root PostgreSQL harness](#part-1-non-root-postgresql-harness)
2. [Part 2: rights inventory and private extraction](#part-2-rights-inventory-and-private-extraction)
3. [The one external step still pending](#the-one-external-step-still-pending)

---

## Part 1: non-root PostgreSQL harness

### 1.1 Current state (read from the files)

| Fact | Where |
| --- | --- |
| `seed` has `user: "0:0"`, `image: openbinding-pgtest-gateway:latest`, no `build`, and one bind `./openbinding-gateway/tests` -> `/app/tests` | `compose.pgtest.json` lines 57-91 |
| `image-builder` is the only service with `build` (`context: .`, `dockerfile: openbinding-gateway/Dockerfile`, **no `target`**); it runs as `65534:65534`, `sleep 3600` | `compose.pgtest.json` lines 40-56 |
| `mem_limit`: postgres 384m + image-builder 64m + seed 768m = **1216 MiB**; the test budget is `int(1.3 * 1024**3)` = 1331 MiB | `compose.pgtest.json`, `tests/test_pg_harness.py:23,230-234` |
| The Dockerfile has **one stage** (`FROM python:3.11-slim`) and ends on `USER 10001:10001`, `EXPOSE 8000`, `ENV FORWARDED_ALLOW_IPS`, `ENTRYPOINT`, `CMD`. It copies `src`, `alembic`, `alembic.ini`, `schemas`, `examples`, `tools`, the two BIM packages; it does **not** copy `tests/` | `openbinding-gateway/Dockerfile` |
| `tests/` is already inside the build context: the root `.dockerignore` has `!openbinding-gateway/**` (and drops `**/__pycache__`, `**/*.pyc`) | `.dockerignore` lines 2-3, 26-29 |
| pytest configuration is `/app/pyproject.toml` (`testpaths=["tests"]`, `pythonpath=["src"]`, `asyncio_mode="auto"`), already copied by `COPY openbinding-gateway/pyproject.toml .` | `openbinding-gateway/pyproject.toml:79-90` |
| What `tests/concurrency` needs at run time: `tests/conftest.py`, `tests/_repo.py` (`REPO_ROOT=/app` through `OPENBINDING_REPO_ROOT`), `tests/_pricing.py` + `tests/_fake_space.py` + `tests/fixtures/pricing_test.yml`, `tests/concurrency/*` (including `_watchdog.py`, `_two_sessions.py`), `/app/alembic` (`GATEWAY_ROOT = parents[2]`), `/app/examples/demo/01_simple_seq` | `tests/concurrency/_two_sessions.py:23,63`, `test_study_cells_pg.py:41`, `test_jobs_idempotency_pg.py:24`, `tests/_pricing.py:14` |
| `tests/concurrency` imports nothing from `lab/tests`, from `tools/` or from `space/` | grep of the imports of `test_*_pg.py` |
| `_watchdog.py` only needs `signal.setitimer`/`SIGALRM` on the main thread, `faulthandler` and `tempfile.TemporaryFile` (so `/tmp`); no file in `/app` is written | `tests/concurrency/_watchdog.py:16-54` |
| Last lab observation recorded: 58 passed, 0 skipped in 12 s, with `seed` as `0:0` | `docs/qa/PG_HARNESS.md` lines 7-14, 250-253 |

Why `0:0` exists (as recorded, not re-observed here): the image runs as uid 10001; under rootless Docker that uid
can be refused on a bind-mounted host directory (`Permission denied`), so the lab fixed the same problem for `tools/`
with `COPY` (Dockerfile lines 54-58, `lab/tests/test_lab_compose.py:290-301`), and the PG harness took the root
workaround for `tests/` instead (`PG_HARNESS.md` lines 94-117, option 3).

### 1.2 Discrepancies found while reading (independent of the change)

1. **`tools/test_pg.sh` does not match `compose.pgtest.json`.** The script runs
   `compose up --build --abort-on-container-exit --exit-code-from runner` (line 24), but the file has no `runner`
   service (`postgres`, `image-builder`, `seed`). `PG_HARNESS.md` lines 144-148 describes a different flow
   (`up --detach --wait postgres`, then `run --rm --no-deps seed`, then `down --volumes`). The documented flow is
   what the script should do; as written it cannot work. It was not executed here (NOT OBSERVED), it is read.
2. **`PG_HARNESS.md` "Mounts" is stale.** It says the image contains `space/pricing/openbinding.yml` copied by a
   `COPY space/pricing/openbinding.yml` Dockerfile line (lines 121-136). The Dockerfile has no such line, and
   `tests/_pricing.py` reads `tests/fixtures/pricing_test.yml`. The `space/` paragraph can be deleted when the
   section is rewritten.
3. `tests/conftest.py:76` imports `_fixtures.micro_instance` inside the fixture `micro_placement_instance`; no file
   called `_fixtures.py` exists in the tree and nothing uses the fixture (only `conftest.py` mentions it). Irrelevant
   for the 58 tests; not part of this change.

### 1.3 The contradiction in the request, and how it is resolved

The request asks for `FROM <final stage> AS test` **and** for the last stage to stay the production one. Docker builds
the **last** stage when no `--target` is given, and `docker-compose.yml` (`gateway`, `gateway-dev`, `worker`,
`worker-dev`) and `compose.lab.json` (`gateway`, line 163) build this Dockerfile with **no `target`**. A `test` stage
that derives from the final stage is necessarily defined after it, so it would become the default target and every
existing build would silently produce the test image.

Two layouts satisfy "production stays last":

* **A (recommended): shared `base`, then `test`, then `production` last.**

  ```dockerfile
  FROM python:3.11-slim AS base
  ... lines 2-82 of today's Dockerfile, byte for byte (everything up to and including the RUN that creates the
      user, chmods /app and owns /var/lib/openbinding) ...

  FROM base AS test
  # tests only: the code under test is already in base; nothing else is installed here
  COPY openbinding-gateway/tests/ tests/
  RUN chmod -R a+rX /app/tests
  USER 10001:10001

  FROM base AS production
  USER 10001:10001
  EXPOSE 8000
  ENV FORWARDED_ALLOW_IPS=127.0.0.1
  ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
  CMD [ ... unchanged ... ]
  ```

  The `test` stage derives from `base`, which is the production content minus its runtime metadata (`USER`,
  `EXPOSE`, `ENV FORWARDED_ALLOW_IPS`, `ENTRYPOINT`, `CMD`). It starts as root, so `chmod -R a+rX /app/tests` (the
  same device as the existing `chmod -R a+rX /app`) works without a `USER root` line, and it ends on the numeric
  non-root user. Production keeps exactly the same files and layers; only the five metadata instructions move to
  the last stage.
* **C (fallback, smaller diff on production): keep today's stage as `runtime`, append `FROM runtime AS test` and a
  final empty `FROM runtime AS production`.** The production instructions do not move at all, but `test` then needs
  `USER root` before the `chmod` (or `COPY --chown=10001:10001`, which leaves the tests owned and writable by the
  runtime user), and the flat parsing in `tests/test_container_hardening.py` (1.4) breaks in more places (a `COPY`
  after the production `USER`). Use it only if moving the metadata lines is rejected.

The rest of this document describes A.

### 1.4 Exact changes by file

#### `openbinding-gateway/Dockerfile`

* Line 1: `FROM python:3.11-slim` -> `FROM python:3.11-slim AS base`.
* Lines 2-82 unchanged and in the same order. Two of them are read literally by other tests and must keep their
  exact text and relative order: `COPY openbinding-gateway/tools/ tools/` and the continuation line
  `&& chmod -R a+rX /app` (`lab/tests/test_lab_compose.py:297-301`).
* Move lines 84-98 (`USER`, `EXPOSE`, the comment and `ENV FORWARDED_ALLOW_IPS`, the comment, `ENTRYPOINT`, `CMD`)
  into a final `FROM base AS production`, and add the `test` stage between `base` and `production` as in 1.3.
* Do **not** add `COPY openbinding-gateway/tests`, `lab/`, a package install or an `apt-get` to `base` or
  `production`. Everything test-only goes after `FROM base AS test`.

Why the `test` stage needs no other `COPY`: `src`, `alembic`, `alembic.ini`, `schemas`, `examples`, `tools`,
`pyproject.toml` and the `[test]` extras (pytest, pytest-asyncio, httpx, ...) are already in `base`. `tests/` is the
only missing piece, and it is copied whole (equal to what the bind provides today) so a new import of another
helper in a concurrency test cannot reintroduce a missing-file failure. Copying only a subset
(`conftest.py`, `_*.py`, `fixtures/`, `concurrency/`) would shrink the layer; the size of `tests/` was not measured
(NOT OBSERVED), so there is no number to justify the extra drift risk.

Not copied on purpose: `lab/tests` (the 58 tests do not read it; copying it would need `!lab/` in the ignore file and
is only needed if a later chunk puts `../lab/tests` in `DEMO_PYTEST_ARGS`), `docs`, `compose*.json`, `tools/test_pg.sh`.

#### `compose.pgtest.json`

* `services.image-builder.build`: add `"target": "test"`. Nothing else changes in that service.
* `services.seed`: delete `"user": "0:0"`. The effective user is the image's `USER 10001:10001` (the same way
  `compose.lab.json`'s `seed` has no `user` key). Setting `user: "10001:10001"` explicitly is possible but duplicates
  the Dockerfile and would drift from it.
* `services.seed`: delete the whole `volumes` key (the only bind). `postgres` keeps its `tmpfs` entry, so the file
  still has a `volumes` array in it.
* Everything else (image tag, `entrypoint: []`, `working_dir`, environment, `depends_on`, `mem_limit`) unchanged.
  Total `mem_limit` stays 1216 MiB.
* The tag `openbinding-pgtest-gateway:latest` is only used by this file (the lab uses `openbinding-lab-gateway:latest`),
  so the test image cannot be mistaken for the production image through the tag.

`build.target` is not new to the lab provider: `compose.lab.json` line 313 already uses `"target": "lab"` for the
frontend, `lab/tests/test_lab_compose.py:33` lists `target` in `ALLOWED_BUILD_KEYS`, and `JOINT_STATUS.md` records that
lab as healthy at `5aebc7c8`. That does not prove the provider accepts `target` for `compose.pgtest.json`
specifically: confirm in the first run.

#### `openbinding-gateway/tests/test_pg_harness.py` (shape tests)

Change:

* `test_only_the_seed_runs_as_root_and_only_to_read_the_tests_bind` (line 173) -> `test_no_service_runs_as_root`:
  for every service, `str(service.get("user", "")).split(":")[0] not in {"0", "root"}`; and `seed` has no
  `user` key (so the image decides) or a numeric non-zero one. This is the "no `user 0:0`" requirement as a test.
* `test_the_only_mount_of_the_seed_is_the_tests_directory` (line 142) -> `test_no_service_bind_mounts_host_code`:
  no mount of type `bind` in any service, and `"volumes" not in services["seed"]`.
* `test_seed_uses_the_gateway_dockerfile` (line 201) compares `(context, dockerfile, target)` of `image-builder`
  with `gateway-dev`, which fails once `target` is `test`. Compare `(context, dockerfile)` only; assert
  `image-builder.build.target == "test"` and `gateway-dev.build.get("target") is None`.

Add (static, no Docker; one helper `_stages()` splits the Dockerfile text at each `FROM`, joining `\` continuations
and dropping comments, as `test_container_hardening.py::instructions` does):

1. The stage names are exactly `["base", "test", "production"]` in that order and the **last** stage is `production`.
2. `test` is `FROM base AS test`, contains `COPY openbinding-gateway/tests/ tests/`, a `chmod -R a+rX /app/tests`
   before its `USER`, ends on `USER 10001:10001`, and contains no `USER root`/`USER 0`, no `ENTRYPOINT`/`CMD`/`EXPOSE`,
   no `pip`/`uv`/`apt-get`/`curl` and no `COPY --from`.
3. No `COPY` source in `base` or `production` starts with `openbinding-gateway/tests` or `lab/` (the production
   image is not thickened).
4. Every `build` in `docker-compose.yml` and `compose.lab.json` that uses `openbinding-gateway/Dockerfile` has no
   `target` (so the last stage is what they build), and only `compose.pgtest.json`'s `image-builder` has
   `target: test`.
5. The `seed` image tag equals the `image-builder` tag (already covered by
   `test_seed_shares_the_image_that_up_always_rebuilds`; keep).

Keep unchanged: the memory-budget test (1216 <= 1331), the forbidden-keys test, the structured-mount test (it asserts
`mounts` is non-empty, which the postgres `tmpfs` still satisfies), the `tmpfs`/PGDATA test and the
`seed` command test.

#### `openbinding-gateway/tests/test_container_hardening.py` (needs a one-line change, not in the requested list)

It reads the Dockerfile as one flat list of instructions. The change is compatible with it except for:

* `test_uv_is_pinned_to_a_release_and_nothing_uses_latest` (lines 99-102) rejects an untagged `FROM`: after the
  change `FROM base AS test` has image `base`. Skip a `FROM` whose image is the name of an earlier stage.

Everything else in that file still passes **if A is used** (checked by reading, not by running): the last `USER` is
the production one and `ENTRYPOINT`/`CMD` follow it; every `COPY` (including the test stage's) precedes it; the single
`uv pip install` is untouched; `chmod -R a+rX /app` is still present; the `groupadd`/`useradd`/`chown` `RUN` is before
the last `USER`. With layout C several of these fail.

`tests/test_docker_context.py` needs no change: `copied_sources()` takes every `COPY` of the file, and
`openbinding-gateway/tests/` is let through by `!openbinding-gateway/**`.

#### `.dockerignore`

No change needed. If `lab/tests` is ever copied, add `!lab/` and `!lab/tests/**` and extend
`tests/test_docker_context.py` accordingly.

#### `docs/qa/PG_HARNESS.md`

* Status paragraph: keep the 58/0 observation with its date and say it was made with `seed` as `0:0`; add a line that
  the `test`-stage version is **not yet observed** until the lab run below is done, then replace it with the result.
* "Services": `image-builder` now builds `target: test` (delete "the Dockerfile has no stages, so no `target`");
  `seed` has no `user`, no bind.
* Replace "Why the seed runs as root" by "Why the seed does not need root": the tests travel in the `test` stage,
  as `tools/` travels in the image; keep the rootless-uid explanation as history.
* "Mounts": no mounts for `seed`; remove the stale `space/` paragraph (1.2, item 2).
* "Format rules": the `user`/bind rules are replaced by "no service runs as root; no host code is bind-mounted".
* "Expected results" and "Open points": drop "the seed ran as `0:0`" and the pending-`test`-stage item, and add the
  residual risks in 1.5.
* "Local": fix `tools/test_pg.sh` (1.2, item 1) or change the text; the file is outside the requested list, so decide
  explicitly.

### 1.5 Risks

| Risk | Detail | Mitigation |
| --- | --- | --- |
| Something the tests wrote as root now fails as uid 10001 | `/app` and `/app/tests` are root-owned and not writable. Evidence it is fine: `-p no:cacheprovider`, `PYTHONDONTWRITEBYTECODE=1`, `tmp_path`/`TemporaryFile` use `/tmp`, the concurrency tests do not use the artifact root, alembic writes nothing to `/app`. **NOT OBSERVED**: it has never run as 10001 | The first lab run decides. If a `PermissionError` appears, fix the test to use `tmp_path`; do not add `chown` or capabilities |
| `Permission denied` on the copied tests | A source file with mode `0600` would stay unreadable for uid 10001 in the layer | The `RUN chmod -R a+rX /app/tests` in `test`; test 2 above pins it |
| Production gets thicker or changes | A `COPY tests` in `base` would put the tests in every image | Test 3 above; the `test` stage is only reachable with `target: test` |
| Default target flips to `test` | Anyone appending a stage after `production` changes what `gateway`, `worker` and the lab build | Test 1 above (last stage is `production`); optionally set `target: production` explicitly in `docker-compose.yml` and `compose.lab.json` later (`ALLOWED_BUILD_KEYS` already allows it) |
| Layer cache | `base` layers are shared with production builds only when the build args are equal: the production compose files pass `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` build args, which become `ENV` in `base`; the pgtest build passes none, so its `base` is a different cache key. Inside the pgtest harness, `COPY tests/` is the last cached layer, so a change in tests rebuilds only `COPY` + `chmod` | Keep `COPY tests` after everything else in the stage; never put it before `uv pip install` |
| Legacy builder | With `DOCKER_BUILDKIT=0` the `test` stage (it precedes `production`) is also built on default builds. It is two cheap instructions; BuildKit (Compose default) skips it | None needed; mention in the Dockerfile comment |
| Image size | One extra layer (the tests) on `image-builder`/`seed` only. Size **not measured** | Measure with `docker image ls` after the first build |
| `[test]` extras already in production | The production image already contains pytest, pandas, scipy, ruff (`uv pip install ... ".[test]"`). Not introduced here, not fixed here | Separate follow-up if production should not carry them |
| Shape test exigencies | If the test only forbade `"0:0"` it would pass `"root"` or `"0"`; if it demanded `user == "10001:10001"` it would duplicate the Dockerfile | Test `no_service_runs_as_root` forbids `0`/`root`; the image decides the user, pinned by Dockerfile test 2 |
| Build memory | `mem_limit` limits run-time containers; the `uv pip install` during `up` is not counted in the 1216 MiB. Unchanged by this change (the image-builder already builds today) | None |
| `build.target` support in `lab_compose` for this file | Precedent exists (`compose.lab.json:313`), not proof | First run |

Optional guard, not recommended: prefixing the `seed` command with `test "$(id -u)" = 10001 &&` would prove the user
inside the run, but it diverges from the lab pattern and the shape test pins the command text. The evidence that the
run was non-root is then: no `user` key, the stage's `USER`, and tests that passed on a root-owned, non-writable `/app`.

### 1.6 Implementation contract and checks

Contract for the worker that implements it (files: `openbinding-gateway/Dockerfile`, `compose.pgtest.json`,
`openbinding-gateway/tests/test_pg_harness.py`, `openbinding-gateway/tests/test_container_hardening.py`,
`docs/qa/PG_HARNESS.md`; optionally `tools/test_pg.sh`):

1. Dockerfile layout A of 1.3; no instruction added to `base` or `production`.
2. `compose.pgtest.json`: `image-builder.build.target = "test"`; `seed` without `user` and without `volumes`; total
   `mem_limit` unchanged.
3. Shape tests as in 1.4; `test_container_hardening.py` one-line change.
4. Docs as in 1.4. The doc must state which results were observed and which were not.

Checks, in this order (indices are those of the implementing task's registry; this task's registry has only the
documentation check):

| Check | Expected | Notes |
| --- | --- | --- |
| Gateway suite without PostgreSQL: `tests/test_pg_harness.py tests/test_container_hardening.py tests/test_docker_context.py ../lab/tests` | all pass, none skipped for a missing file | Run from a checkout; `OPENBINDING_SKIP_COMPOSE_SHAPE` unset |
| `git diff --check` | clean | |
| `lab_compose` `file=compose.pgtest.json` `up` | `postgres` healthy; `image-builder` built with `target: test` and healthy | Builds the image; check the build used the `test` stage |
| `lab_compose` `seed` with `DEMO_PYTEST_ARGS='-rfEs --tb=short --durations=8 tests/concurrency'` | exit code 0; **58 passed, 0 skipped**; per-file counts as in `PG_HARNESS.md` (`test_job_leases_pg` 9, `test_job_publication_pg` 9, `test_jobs_idempotency_pg` 1, `test_pg_guard` 1, `test_pg_harness` 15, `test_study_cancel_pg` 5, `test_study_cells_pg` 3, `test_sweep_vs_cancel_pg` 3, `test_two_sessions_smoke` 1, `test_watchdog` 11); no `Permission denied`; no `SKIPPED` (`-rs`) | The watchdog (`OPENBINDING_PG_TEST_TIMEOUT`, 60 s default) is part of `tests/concurrency` and is preserved because the directory is copied whole |
| `lab_compose` `down` | clean | |

Any result other than 58/0 is reported as such; a skip is a defect.

---

## Part 2: rights inventory and private extraction

Scope: `bim-toolchain/` (174 files in the tree at the time of reading). The repository is `javiercavlop/bim-toolchain`,
private, **not created yet** according to `bim-toolchain/docs/EXTRACTION_LOG.md` (line 4) and `docs/BIM_CORE.md`
("Licence and publication"); the remote configuration could not be read from this worker, so that is the repository's
own statement, not an observation of GitHub.

This is an inventory, not legal advice, and it grants nothing. It proposes no licence, no relicensing and no public
visibility.

### 2.1 Statements the repository itself makes

* `bim-toolchain/NOTICE.md`: "The license of the BIM toolchain code has **not been decided**. The holder of the rights
  has yet to choose it." No licence is declared in the three `pyproject.toml` (`license-files = ["NOTICE.md"]`, no
  `license` field, classifier `Private :: Do Not Upload`).
* `LICENSE` (CC BY 4.0, no holder named anywhere) and `THIRD_PARTY_NOTICES.md` are described as copied unchanged from
  OpenBinding "so that no existing notice is lost", and "not a decision about this code's future license".
* `docs/RELEASING.md` "Decide before extracting": the licence **and the copyright holder**, "which may not be the same
  for code written inside a university project"; whether the history may travel; private index vs release assets;
  corpus access in CI.
* `NOTICE.md`: "No dataset is redistributed here." The corpus "stays in OpenBinding". Consistent with the tree: no
  file under `bim-toolchain/` is a dataset or corpus package (the only corpus-related files are the digests in
  `golden/`, below).

### 2.2 Source -> origin -> licence/rights -> redistributable in a private repo? -> action

"Holder" means the copyright holder. No file in the repository names one (no copyright line in `LICENSE`, `NOTICE.md`,
the READMEs, the `pyproject.toml` files or the `README.md` of the repository root, which has no licence section), so
**titularity is NOT VERIFIABLE for everything that is not a third-party file below.**

| # | Source (path under `bim-toolchain/`) | Origin | Licence / rights found | Redistributable in a private repo? | Action |
| --- | --- | --- | --- | --- | --- |
| 1 | `packages/bim-core/src/bim_core/*.py` (compiler, canonical, package, expressions, evaluator, ...) | Copied from `openbinding-gateway/src/openbinding_gateway/v1/` and `services/`, `routes/` (`EXTRACTION_LOG.md`), then edited | None declared (pending). Holder not stated: **NOT VERIFIABLE** | Unknown. Putting one's own work in one's own private repository needs no third-party permission, but nothing here shows the account owner is the holder (the university-project caveat is in `RELEASING.md`) | Owner confirms the holder in writing (person/institution) and that the institution, if any, allows a private copy. Record it in the manifest (2.3). Do not pick a licence |
| 2 | `packages/bim-service/**`, `packages/bim-client/**`, `tools/*.py`, `packages/*/tests/**`, `.github/workflows/*.yml`, `docs/*.md`, `README.md`, `CHANGELOG.md` | New files written in the extraction tasks ("all new code, no platform code copied", `EXTRACTION_LOG.md` step 4) | None declared. Holder **NOT VERIFIABLE**. No third-party attribution found by searching for "adapted from / based on / ported from / derived from / copied from / github.com / SPDX / MIT License / Apache" in `src`, `tools` and workflows (not an exhaustive review of the code) | Same as row 1 | Same as row 1 |
| 3 | `LICENSE` | Byte copy of the OpenBinding root `LICENSE`, Creative Commons Attribution 4.0 International text | CC BY 4.0 text; it states the licence of OpenBinding's *content*, "not a decision about this code's future license" (`NOTICE.md`). The copy being identical was **not diffed** here | It is a licence text, normally redistributed with the work it covers. Whether it covers the code is exactly what `NOTICE.md` leaves open | `cmp LICENSE bim-toolchain/LICENSE` at export time. Owner decides whether it stays (RELEASING.md item 1). Do not edit it |
| 4 | `THIRD_PARTY_NOTICES.md` | Byte copy of the OpenBinding file | Credits for the **platform**: the Universidad de Sevilla mark (no image file of it exists under `bim-toolchain/`), and MIT projects SPHERE, SPHERE docs, SPACE, space-python-client, Pricing4TS, space-react-client, pricing-renderer, whose "patterns" the platform adapts. Nothing under `bim-toolchain/` imports or copies any of them (search of `src`/`tools`: no reference) | A notice file is redistributable; the issue is accuracy: it describes dependencies the toolchain does not have, and its table has a 4-column separator over 3-column rows | Owner decides whether it stays as is, is trimmed or replaced. Not edited here (the packaging tests assert it is shipped/not shipped as written) |
| 5 | `packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2/{BPMN20,Semantic,BPMNDI,DC,DI}.xsd` and its `README.md` | Downloaded "unchanged on 2026-08-09" from omg.org (`README.md` lines 1-12; the date and the unchanged claim are the README's own, not verified). Same files were in the gateway before | **The files contain no copyright or licence text at all**: zero XML comments in the five XSDs and no `copyright`/`license` word (searched, case-insensitive). The only OMG mentions are namespace URIs. So the claims "copyright and license notices ... are preserved byte for byte" (`NOTICE.md`) and "notices are preserved in the upstream files" (vendor `README.md`) are not supported by the files as they are here: there is nothing to preserve in them. **OMG's redistribution condition for these files is NOT VERIFIABLE from the repository, and is not asserted here** | **Unknown.** Not asserted to be allowed or forbidden | (a) The owner reads OMG's current terms for the machine-readable BPMN 2.0.2 files at the URLs the README lists, and records URL, retrieval date and the quoted clause in the manifest; (b) if they do not clearly allow it, ask OMG or replace the vendored copy by a fetch step that verifies the SHA-256s (note: the bundle is needed offline by `bim_core` and ships in its wheel, sdist and in the gateway image); (c) correct the two sentences in `NOTICE.md`/`README.md`; (d) recompute the five SHA-256 (listed in the vendor README) with `sha256sum`: **not recomputed here** |
| 6 | `.../resources/schemas/bim/v1/*.schema.json` (12) and `.../schemas/engine-contract.openapi.yaml` | Byte copies of OpenBinding `schemas/bim/v1/` and `schemas/engine-contract.openapi.yaml` (`EXTRACTION_LOG.md`; `tests/test_bim_schema_parity.py` keeps both copies equal) | Authored in OpenBinding: same (unstated) holder, same licence status as OpenBinding's content (CC BY 4.0 text at its root, scope **NOT VERIFIABLE**). Whether they embed third-party text was not reviewed | Unknown (depends on the holder, as row 1) | Same confirmation as row 1; list in the manifest as `origin: openbinding` with the source commit SHA |
| 7 | `packages/bim-core/tests/fixtures/manifests/*.json` (4 Engine manifests), `contracts/consumers/openbinding/*.json`, `contracts/openapi/*.json` | Manifests copied from OpenBinding (`.copied` marker file is empty); contracts generated | Same holder question | Unknown (row 1) | Same as row 1 |
| 8 | `packages/bim-core/tests/fixtures/example-package/*`, `example-binding.json` | Synthetic demo package written for the toolchain (`consumer_fixtures.py`); `example-binding.json` is an unused identical leftover (`EXTRACTION_LOG.md`) | Synthetic, no third-party data found | Unknown (row 1) | Optionally delete `example-binding.json` before export; does not affect rights |
| 9 | `golden/bim_baseline/*.json` (5) | Byte copies of `openbinding-gateway/tests/golden/bim_baseline/` | Digests and numeric summaries derived from evaluating the 82-package corpus. `corpus.json` records the **paths** of 82 packages: 4 Engine fixtures, 20 demo, 6 literature, 4 placement and 48 `experimentation/icws/instances/<scenario>_<variant>` (six scenarios x eight variants; scenario names carry author and year, e.g. `benatallah2002`, `bultan2003`). No dataset content, but the numbers derive from third-party-sourced scenarios. Whether derived digests/summaries carry any source obligation is **NOT VERIFIABLE** here | Unknown; the exposure is limited to digests, summaries and names | Owner confirms with the holder/institution; if in doubt keep them out of the first push and accept that the corpus-comparison test then skips (`BIM_CORPUS_OPTIONAL=true`) |
| 10 | `golden/bim_core/*.json`, `golden/vectors_extra.json` | New; created by the tests on first run (`EXTRACTION_LOG.md`) | Synthetic / derived from the above digests | Unknown (row 1; `bim_core/compat.json` and `protocol.json` list Engine manifests of the platform) | Same as row 1 |
| 11 | **ICWS corpus** (`experimentation/icws/instances/*`, 48 packages; generator `experimentation/icws/generator.py`) and the `examples/literature/*` (6) it derives from | **Not under `bim-toolchain/`.** Derived from six papers (e.g. `examples/literature/benatallah/instance.json` cites a paper and says the QoS values "are illustrative because the paper does not provide numeric QoS") | `datasets/recovery_catalogue.json` lists `01_icws` (48 instances) with source "QoS-driven Web Service Composition Benchmarks (ICWS 2007)", authors Alrifai/Risse/Dolog, year **2009**, licence label **"Open Academic Research Benchmark"**. That label is not a licence name or text, and the entry's description (real QoS matrices) does not match the in-tree packages (illustrative QoS, six scenarios): **internal inconsistency; licence NOT VERIFIABLE** | Not applicable: **not taken** | Keep out. Before export assert no such path is tracked (2.4). Resolve the catalogue inconsistency in OpenBinding, separately |
| 12 | **Datasets** (`datasets/`, QACOBench: `02_quantum`, `03_hsc_llm`, `04_rprsr15`, `05_iots`, `06_bws_scp`, `07_qfbs`) | Not under `bim-toolchain/`; in the checkout only `datasets/README.md`, `RECOVERY_CATALOGUE.md`, `recovery_catalogue.json` exist (sources and generated suites are absent) | Per the catalogue: RPRSR15 "GNU LGPL v3.0 / Open Access"; IoTS CC-BY-4.0; QFBS CC-BY-4.0; others "Open Academic Research Benchmark" (not a licence); HSC-LLM has authors "HSC Research Group" and no URL. All as claimed by the catalogue, **none verified** | Not applicable: **not taken** | Keep out |
| 13 | Third-party **dependencies** (not vendored, referenced in `pyproject.toml`) | `bim-core`: jsonschema, lxml, pyyaml; `bim-service`: fastapi, pydantic, uvicorn (+ test: httpx, pytest); `bim-client`: httpx (+ test: bim-service, pytest); build: hatchling; dev: ruff | **There is no `uv.lock` under `bim-toolchain/`** (the only lock is `openbinding-gateway/uv.lock`; `EXTRACTION_LOG.md` lists a lock as missing). That lock pins, among others, fastapi 0.141.1, httpx 0.28.1, jsonschema 4.26.0, lxml 6.1.1, pydantic 2.13.4, pytest 8.4.2, pyyaml 6.0.3, starlette 1.3.1, uvicorn 0.52.0, ruff 0.16.0, and records no licence. Licences: **NOT VERIFIED**. As a hypothesis from earlier releases of these projects (MIT for most; BSD-3-Clause for lxml, uvicorn, httpx, starlette), to be checked against the installed metadata; transitive packages (including any with weak-copyleft terms, and the C libraries bundled in the `lxml` wheel) were not examined | Dependencies are not copied into the repository, so pushing it redistributes none of them. They are redistributed only when an image or bundle containing them is distributed (e.g. the `bim-service` Dockerfile) | Generate the inventory from a clean install of the locked set (2.6) and put its output in the manifest; no change to the repository now |
| 14 | `.gitignore`, `.dockerignore`, `.extraction-bootstrap` | Housekeeping; `.extraction-bootstrap` contains the line `bootstrapped-by-supervisor-check` | None relevant | Not part of the product | Drop `.extraction-bootstrap` from the export |

### 2.3 Proposed manifest of sources and rights

File: **`bim-toolchain/docs/RIGHTS_MANIFEST.json`** (JSON: no new parser dependency; the repository already pins
documents with JSON and checks them with tests). Human-readable explanation stays in `NOTICE.md`, which the owner
edits. The manifest records facts and their evidence; it does not choose a licence.

Format (one object per source; `UNKNOWN` is a legal value, an invented value is not):

```json
{
  "manifestVersion": 1,
  "repository": "javiercavlop/bim-toolchain",
  "sourceRepository": { "name": "OpenBinding", "commit": "<sha of the exported commit>" },
  "visibility": "private",
  "entries": [
    {
      "id": "omg-bpmn-2.0.2-xsd",
      "paths": ["packages/bim-core/src/bim_core/resources/vendor/omg/bpmn/2.0.2/*.xsd"],
      "kind": "third-party-file",
      "origin": { "type": "download", "urls": ["https://www.omg.org/spec/BPMN/2.0.2", "https://www.omg.org/spec/BPMN/machine-readable"], "retrieved": "2026-08-09", "modified": false },
      "sha256": { "BPMN20.xsd": "a07c159c...0705", "Semantic.xsd": "c4318842...d9a7", "BPMNDI.xsd": "f0dff1cd...b038", "DC.xsd": "a2f90e5a...312d", "DI.xsd": "8220b179...4498" },
      "rightsHolder": "Object Management Group (per the source URL; terms UNVERIFIED)",
      "licence": { "id": "UNKNOWN", "evidence": [], "note": "files carry no notice" },
      "redistribution": { "privateRepository": "UNVERIFIED", "public": "not proposed" },
      "status": "blocked",
      "verifiedBy": null,
      "verifiedOn": null,
      "action": "record OMG terms (URL, date, quoted clause) or replace by verified fetch"
    },
    {
      "id": "bim-core-code",
      "paths": ["packages/bim-core/src/bim_core/*.py"],
      "kind": "own-code",
      "origin": { "type": "copied-from", "repository": "OpenBinding", "paths": ["openbinding-gateway/src/openbinding_gateway/v1/"] },
      "rightsHolder": "UNKNOWN",
      "licence": { "id": "UNDECLARED", "evidence": ["NOTICE.md: decision pending"] },
      "redistribution": { "privateRepository": "UNVERIFIED", "public": "not proposed" },
      "status": "blocked",
      "action": "holder confirms in writing"
    }
  ]
}
```

Entries to create, one per row of 2.2: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14 (with `"excluded": true` for the corpus and
datasets, rows 11 and 12, so that their absence is a recorded decision), and one `dependencies` entry that points to the
generated inventory (2.6) and holds its SHA-256.

Allowed `status` values: `confirmed` (evidence recorded, named verifier, date), `unverified`, `blocked`, `excluded`.

A gate test (`tools/test_rights_manifest.py`, to be written by the implementing task, not by this one):

1. every tracked file under the repository is matched by exactly one `paths` glob;
2. the SHA-256 listed for each vendored file equals the file;
3. `--require-confirmed` (used by the release workflow and by the publication script) fails if any entry is not
   `confirmed` or `excluded`;
4. no entry has `licence.id` filled with a value that is not backed by a non-empty `evidence` list;
5. no path matching `icws`, `datasets`, `qacobench` or `literature` is tracked.

Note that `tools/test_packaging_metadata.py` and `packages/bim-core/tests/test_boundary.py` assert that no licence is
invented; they must not be loosened by this work.

### 2.4 Self-contained extraction plan

Why a plain directory export is the default: `RELEASING.md` still lists "whether the history may travel" as open, and
the rights above are unconfirmed. An export puts a single, reviewable commit in the new repository; history can be
added later by the owner's decision, the reverse is not possible once pushed (a push may be cached or indexed even if
deleted).

**What travels:** the tree of `bim-toolchain/` at one OpenBinding commit `SRC_SHA`, without `.extraction-bootstrap`.
Optionally without `packages/bim-core/tests/fixtures/example-binding.json`.

**What does not travel:** the ICWS corpus, the `examples/**` corpus, `engines/*/tests/fixtures`, `datasets/**`,
`experimentation/**`, anything of `openbinding-gateway`. None of these is under `bim-toolchain/`, so the export
excludes them by construction; the checks below prove it.

Option A, recommended: export of the directory, one new commit (no history).

```sh
# Run inside the OpenBinding checkout, at a clean commit. Read-only on OpenBinding.
SRC_SHA=$(git rev-parse HEAD)
git status --porcelain                                  # must print nothing
# 1. the corpus and datasets are not tracked under the prefix (file names)
git ls-files bim-toolchain | grep -Ei '(icws|datasets|qacobench|literature|\.zip$)' && echo "STOP: corpus-like file" || echo ok
# 2. the content references that remain (golden paths, docs) are only names, review them
git grep -n -I -E 'experimentation/icws|datasets/|examples/literature' -- bim-toolchain
# 3. export the subtree as it is at SRC_SHA, outside the checkout
EXPORT=$(mktemp -d /tmp/bim-toolchain-export.XXXXXX)
git archive --format=tar "$SRC_SHA:bim-toolchain" | tar -x -C "$EXPORT"
rm -f "$EXPORT/.extraction-bootstrap"
```

Option B, with history (needs the owner's explicit decision; `RELEASING.md` documents `git subtree split`):

```sh
git subtree split --prefix=bim-toolchain -b bim-toolchain-split   # in the OpenBinding checkout; creates a local branch
```

or, on a throwaway **clone** (never on the original), `git filter-repo --subdirectory-filter bim-toolchain`. Consequences
to decide first: every commit message and author of every commit that touched the prefix travels (the recent messages
are of the form `Complete task <id>`); earlier states of every file travel, including files later deleted; the
bootstrap marker file is in the history. Do not use `--mailmap`, `--commit-callback` or any rewrite that changes
authorship or attribution of existing commits; the split creates new commit ids but keeps authors.

**Self-containment check on the export (no network needed for the first two):**

```sh
cd "$EXPORT"
grep -rIn --include='*.py' -E 'openbinding_gateway|\.\./\.\./(openbinding|schemas|examples)' packages tools | grep -v test_boundary   # expect only strings in boundary tests
BIM_CORPUS_OPTIONAL=true BIM_CORPUS_ROOT="$EXPORT/nonexistent" \
  PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src \
  python -m pytest --rootdir=. packages/bim-core/tests packages/bim-service/tests packages/bim-client/tests tools
```

Expected: corpus-dependent tests skip with a warning (as `README.md` says); the previous result with the corpus
present was 1279 passed, 1 xfailed, 0 skipped (`EXTRACTION_LOG.md`). A different number without the corpus is not a
failure by itself, but it must be reported with the skip count. Note that the golden comparison against the corpus is
then not exercised in the new repository; its CI job (`ci.yml` lines 114-142) needs `vars.BIM_CORPUS_ROOT` or
`BIM_CORPUS_OPTIONAL=true`, and the second one makes the job say it skipped. Do not copy the corpus to satisfy it.

### 2.5 Reproducible build

Current state (read): the three packages build with hatchling (`hatchling>=1.27`, unpinned upper bound), version `0.1.0`
written twice per package (`pyproject.toml`, `_version.py`; a test fails if they differ), `uv build` per package; built
twice with **equal sizes**, but sizes are not hashes: byte-identical output was **not** shown. No lock file exists in
`bim-toolchain`.

Contract:

1. **Lock:** `uv lock` at the workspace root (needs the package index; not possible in this worker) commits
   `bim-toolchain/uv.lock`, which records sha256 for every sdist/wheel it names. Use `uv sync --locked` in CI and for
   builds.
2. **Version:** `0.1.0`, equal in the six places the test checks, `CHANGELOG.md` entry moved from `[Unreleased]`, tag
   `v0.1.0` (the release workflow refuses a tag that disagrees).
3. **Build backend pinned:** put the exact `hatchling` version resolved by the lock in a constraints file with its hash
   and pass it to `uv build` (check the option name with `uv build --help` for uv 0.8.22, which `openbinding-gateway/Dockerfile`
   pins; not verified here).
4. **Build twice, compare hashes:**

   ```sh
   export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)      # commit time of the export commit
   for run in a b; do
     rm -rf "dist-$run"
     for p in bim-core bim-service bim-client; do (cd "packages/$p" && uv build --out-dir "../../dist-$run"); done
   done
   (cd dist-a && sha256sum * ) > SHA256SUMS.a
   (cd dist-b && sha256sum * ) > SHA256SUMS.b
   cmp SHA256SUMS.a SHA256SUMS.b && echo reproducible
   ```

   Whether hatchling output is byte-identical with `SOURCE_DATE_EPOCH` set is expected from its documented
   behaviour but **NOT OBSERVED** here; if `cmp` fails, the release must say so instead of claiming reproducibility.
5. **Verify** as `docs/PACKAGING.md`: clean venv, `pip install dist/*.whl`, `python -I tools/smoke_installed.py ...`, the
   three `compilerDigest` values equal (`sha256-18a20c7d...5172` was the recorded value; it changes if any `.py` or
   resource changes).
6. **Artifacts:** `dist/*.whl`, `dist/*.tar.gz`, `toolchain.json` (`tools/toolchain_json.py`), `SHA256SUMS`; the release
   workflow already creates a **draft** release with these. Nothing goes to PyPI (`Private :: Do Not Upload`).
7. **Dependency licence inventory** from a clean install of the lock (not run): create a venv from `uv sync --locked`
   and run a licence reporter over it (for example `pip-licenses --format=json --with-urls --with-license-file`), store the
   JSON and its SHA-256 next to the manifest.
8. Pin the workflow actions to commit SHAs (existing TODO in both workflow files) before relying on them; they run on the
   first push.

### 2.6 Private publication commands (NOT EXECUTED)

Preconditions (all of them; see the next section): rights confirmed in the manifest (`status` `confirmed` or `excluded`
for every entry, including the OMG XSDs), repository created empty and private by its owner, and a credential limited
to that repository. These commands are written for the person or process that holds that credential; this worker has
neither and ran none of them.

```sh
set -eu
# Environment (never written to the repository or to a log):
#   OPENBINDING_CHECKOUT  path of a clean OpenBinding checkout
#   SRC_SHA               the commit exported and reviewed
#   OWNER_NAME, OWNER_EMAIL   identity the owner wants on the single import commit
#   BIM_TOOLCHAIN_PUSH_TOKEN  fine-grained token limited to javiercavlop/bim-toolchain (see below)

# 0. Stop if the repository is already public: an unauthenticated request must NOT see it.
code=$(curl -s -o /dev/null -w '%{http_code}' https://api.github.com/repos/javiercavlop/bim-toolchain)
[ "$code" = "404" ] || { echo "unexpected HTTP $code: repository visible or API problem, stop"; exit 1; }
# (404 also means "does not exist"; confirm it exists and is private with the credential before pushing, step 3.)

# 1. Export (Option A of 2.4) and the gate checks.
EXPORT=$(mktemp -d /tmp/bim-toolchain-export.XXXXXX)
git -C "$OPENBINDING_CHECKOUT" archive --format=tar "$SRC_SHA:bim-toolchain" | tar -x -C "$EXPORT"
rm -f "$EXPORT/.extraction-bootstrap"
cd "$EXPORT"
python tools/test_rights_manifest.py --require-confirmed        # gate test of 2.3; does not exist yet

# 2. One import commit, with the owner's identity, naming the source commit.
git init -b main
git add -A
git -c user.name="$OWNER_NAME" -c user.email="$OWNER_EMAIL" \
    commit -m "Import bim-toolchain from OpenBinding at $SRC_SHA"

# 3. Credential through the environment, not through argv or the remote URL.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=http.https://github.com/.extraheader
export GIT_CONFIG_VALUE_1="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$BIM_TOOLCHAIN_PUSH_TOKEN" | base64 -w0)"
git remote add origin https://github.com/javiercavlop/bim-toolchain.git
git ls-remote origin                      # must succeed and list nothing (empty repository)

# 4. Push the branch. No force, no other refs.
git push --set-upstream origin main

# 5. Only after the reproducible build of 2.5 is verified and the version/changelog agree:
git tag -a v0.1.0 -m "bim-toolchain 0.1.0"
git push origin v0.1.0                    # triggers release.yml: a DRAFT release; a person reviews it
```

Credential requirements (to be confirmed against GitHub's documentation when it is issued; not verified here):

* The repository is created by its owner first, **empty and private, without a README, `.gitignore` or licence template**
  (a template licence would be a licence created by default).
* A fine-grained personal access token whose "Repository access" is **only** `javiercavlop/bim-toolchain`, with
  "Contents: read and write" and "Metadata: read"; pushing `.github/workflows/*.yml` additionally needs the "Workflows"
  permission (without it the push is rejected). Short expiry (days), revoked after the push. Alternative: a deploy
  key with write access on that single repository (scoped by construction; whether it may push workflow files was
  not verified).
* The token must not be an account-wide classic token, must not be able to create repositories, and must not be stored
  in the repository, Compose files or logs.

Never done by this plan: making the repository public, adding a licence, changing OpenBinding (it keeps consuming the
packages by path), pushing OpenBinding, force-pushing, rewriting existing commits.

---

## The one external step still pending

Everything above is documentation. Code and Compose changes of Part 1 can be done and checked inside the lab with no
external dependency (a Dockerfile `test` stage, one `target`, shape tests). The **only** step that cannot be done from
the repository, in either part, is the publication of `bim-toolchain` to `javiercavlop/bim-toolchain`, and it waits for
two things that come from outside:

1. **Rights confirmed.** In writing, recorded in `docs/RIGHTS_MANIFEST.json`: who holds the copyright of the toolchain
   code and of the OpenBinding-derived schemas (and whether an institution must agree to a private copy); and OMG's
   actual terms for the five BPMN 2.0.2 XSD files (URL, retrieval date, quoted clause), since the files carry no notice
   and the repository's two sentences about "preserved notices" are not supported by them. The decisions listed in
   `RELEASING.md` (history, `LICENSE`/`THIRD_PARTY_NOTICES.md`, corpus access in CI) are the owner's.
2. **A Git credential limited to that one repository** (2.6), issued after the owner creates the empty private
   repository.

Until both exist, no `git remote add`, no push and no tag.

## What was not verified

* No build, no run, no Docker, no lab: the Part 1 layout was checked only by reading the tests that parse the
  Dockerfile (`test_container_hardening.py`, `test_docker_context.py`, `lab/tests/test_lab_compose.py`).
* Not run: any pytest, `uv`, `git`, `sha256sum`, `cmp`; no byte comparison of the copied files; no history read.
* Not read: OMG's terms, GitHub's current token documentation, the licences of any dependency, the remote
  configuration of the repository.
* File counts come from file listings (174 files under `bim-toolchain/`, 82 packages in `golden/bim_baseline/corpus.json`).

## Estado de este documento

* Base: `cd0e05f0`.
* Solo lectura del repositorio; no se ejecutó Docker.
* La primera ejecución real del stage `test` en el lab decide si `lab_compose` acepta `build.target` para
  `compose.pgtest.json` (hay precedente en `compose.lab.json`, pero no es prueba).
* Único paso externo pendiente: derechos confirmados y una credencial Git de alcance limitado al repositorio
  privado `javiercavlop/bim-toolchain`.
