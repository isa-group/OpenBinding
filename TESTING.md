Status: DRAFT for owner review (2026-10-21)

# TESTING — OpenBinding

How behaviour is proven in this repository. Commands are the ones CI (`.github/workflows/ci.yml`) and the existing
docs use; `AGENTS.md` §3 lists them per component. Counts are from `spec/platform-baseline` (from
`integration/platform` @ 912648c), counted by file inspection, not by running the suites.

## 1. Test pyramid per component

| Component | Unit | Integration / contract | End-to-end | Framework |
|---|---|---|---|---|
| Gateway (`openbinding-gateway/tests/`) | 143 `test_*.py` files, ~1,840 test functions; SQLite + `httpx`/`TestClient`, fakes for SPACE (`_fake_space.py`) | `tests/concurrency/*_pg.py` (real PostgreSQL 16, via `tools/test_pg.sh` / `compose.pgtest.json`); `tests/integration/` (`-m integration`, needs the Compose stack: engine representation, ICSOC regression, v1 gateway); OpenAPI contract tests (`test_openapi_contract.py`, `test_b4_*`); BIM consumer contract (`test_bim_consumer_contract.py`) | lab smoke `tools/smoke_lab.py` (9 steps) | pytest 8, pytest-asyncio (auto) |
| BIM toolchain (`bim-toolchain/`) | `packages/*/tests` (~950 test functions) | goldens (`golden/**`), equivalence `InProcessBim` ≡ `HttpBim`, consumer fixtures (`contracts/consumers/openbinding/`), OpenAPI snapshot | `tools/verify_release.py` (reproducible wheels, clean-venv smoke) | pytest |
| Corpus | — | `tools/check_bim_corpus.py --expected 82` (every checked-in package compiles), `tools/check_bim_guard.py`, deterministic package builds (CI `bim-corpus`) | — | stdlib |
| Java engines (`engines/`) | JUnit 5: `CanonicalEvaluatorConformanceTest`, `EngineJobsTest`, `EngineHttpTest`, per-engine `V1*SearchTest`, `*CancelTest`, `EvolutionarySolverTest` | `engines/e2e/test_java_engines_ir02.py` (real `java`) | through gateway integration suite | Maven Surefire, JUnit Jupiter |
| MiniZinc engine (`engines/minizinc-csp/`) | `node --test`: `conformance`, `job_manager`, `minizinc_runner`, `cancel` (fake MiniZinc) | `pnpm test:lab` with `MINIZINC_REAL=1` (5 tests against real MiniZinc, lab image) | gateway integration | Node test runner |
| Frontend (`frontend/`) | Vitest + Testing Library + jsdom: 177 `*.test.ts(x)` files (models, pages, routes, hygiene, touch targets) | API client tests against recorded problem documents | Playwright: project `mocked` (Vite dev server, API answered by the spec) and project `live` (`e2e/live/*`, against the lab at `http://localhost:18100`, screenshots 1440×900 and 390×844) | Vitest 4, Playwright 1.62 |
| Lab profiles (`lab/tests/`) | static checks of `compose.lab*.json` (memory budget, secrets, published ports) | — | `process_probe.py`, `cancel_probe.py` in the lab | pytest |
| QACOBench (`experimentation/qacobench/`) | `test_qacobench.py` (registry/seed stability, resume key, rejection classification, reconciliation, recovery provenance) | `run.sh pilot` (2 instances × 3 engines); `verify_dataset_digests.py` | full campaign (reference `reference/1.1.1/`) | pytest, Docker Compose |
| ICSOC (`experimentation/icsoc/`) | `generator/tests` (needs the dataset from the branch `data/icsoc-original-dataset`, skipped otherwise) | `tests/integration/test_icsoc_regression.py` (skipped without the dataset) | — | pytest |

## 2. `acceptance/` layout and runners

```
acceptance/
  README.md               # how to run, which runner per surface
  api/
    pytest.ini            # runner configuration (pytest)
    conftest.py           # maps "no tests collected" (exit 5) to exit 0
    <capability>/
      test_<slug>.py      # tagged [utest->req~<capability>-<slug>~N]
  ui/
    <capability>/
      <slug>.spec.ts      # Playwright; tagged the same way
```

- Written only by the test-designer from the spec and public interfaces (OpenAPI, BIM schemas, engine protocol,
  route registry); never by the implementer; frozen for the duration of a change (G4).
- Gateway acceptance tests are pytest against `create_app()` or the Compose stack; frontend acceptance tests are
  Playwright specs; engine acceptance tests speak `bim-engine/v1` over HTTP.
- One runner per surface, both exit 0 while `acceptance/` holds no tests:
  - API, from the repository root (CI job `lab`):
    `openbinding-gateway/.venv/bin/python -m pytest -c acceptance/api/pytest.ini acceptance/api`.
  - UI, from `frontend/` (CI job `frontend`):
    `pnpm exec playwright test --config playwright.acceptance.config.ts --pass-with-no-tests`. The configuration
    (`frontend/playwright.acceptance.config.ts`) has `testDir` `../acceptance/ui` and starts the Vite dev server unless
    `PLAYWRIGHT_BASE_URL` is set.
- `--pass-with-no-tests` and the exit-5-to-0 mapping of `acceptance/api/conftest.py` exist only for the empty start. Remove
  them when the first acceptance test of each surface lands, so that a runner that collects nothing fails from then on.
- Engine acceptance tests (`bim-engine/v1` over HTTP) are pytest files under `acceptance/api/<capability>/`.

Decision: one top-level `acceptance/` with one runner per surface, not an `acceptance/` inside each component. The
tests are frozen apart from the implementation (G4), so they sit outside the component trees that the implementer edits.

## 3. Property-based tests

None exist yet (`.hypothesis/` is git-ignored but Hypothesis is not a dependency). Candidates, in order of value:
canonical JSON/digest invariance (bim-core), IR order normalisation (directory ≡ ZIP ≡ permutations), evaluator
monotonicity/aggregation laws, idempotency fingerprint invariance, problem-document shape for any 422.
Tools: Hypothesis (Python), fast-check (TS), jqwik (Java). Adding them is a dependency change (CRP-free if test-only).

## 4. Contract tests

- HTTP: `docs/openapi.json` snapshot (`dump_openapi.py --check`) + `test_openapi_contract.py` (operation ids, tags,
  security documented equals runtime dependencies, media types, error shape). GAP: no Schemathesis fuzzing (G7).
- BIM: `bim-toolchain/contracts/consumers/openbinding/*.json` replayed by `tests/test_bim_consumer_contract.py` (gateway)
  and `tools/consumer_fixtures.py --check` (toolchain).
- Engines: `schemas/engine-contract.openapi.yaml`; conformance of a registration is verified by the gateway
  (`services/engine_registry.py` → `bim_core.conformance`); Java `CanonicalEvaluatorConformanceTest`, MiniZinc `conformance.test.ts`.
- Pricing: `pricingManifest.test.ts`, `test_published_pricing.py` (read-only SPHERE document).

## 5. Mutation testing

Not configured anywhere (GAP). Proposed tools: `mutmut` (gateway, bim-toolchain), Stryker (frontend, minizinc-csp),
PIT (Java engines). Run on changed lines only in PR CI (GitHub Actions), threshold calibrated during the pilot and
recorded in `.agentic/project.yaml`.

## 6. End-to-end

The QA gallery (`frontend/e2e/qa-gallery.spec.ts`) writes screenshots to `QA_GALLERY_DIR` (default
`frontend/node_modules/.cache/qa-gallery/screenshots/`); screenshots are never committed.

- Mocked browser suite: `cd frontend && pnpm test:e2e` (CI: three shard jobs `frontend-e2e`, see section 10).
- Live suite against the lab: `PLAYWRIGHT_BASE_URL=http://localhost:18100 LAB_SEED_PASSWORD=<synthetic> pnpm exec playwright test --project=live`.
- API smoke against the lab: `openbinding-gateway/tools/smoke_lab.py` (via the lab seed container).
- Real engines: `docker compose exec -T gateway-dev test tests/integration -m integration`.

## 7. Data rules for tests

- Synthetic only: synthetic accounts (`alice`…`frank`, `admin` with the documented dev passwords exist only in
  `tools/seed_dev.py` for local stacks), generated BIM packages, fixtures under `tests/fixtures`. No personal or
  production data, no real credentials, no calls to SPACE/SPHERE/Zenodo.
- Corpus-dependent tests read `examples/` and the corpus through `BIM_CORPUS_ROOT`; in an exported `bim-toolchain` they
  are excluded with `-m 'not openbinding_corpus'`.
- Datasets from Zenodo are never required by the default suites.

## 8. Known red checks at 912648c (NOT a pass)

- `python3 tools/check_bim_guard.py` (CI job `bim-corpus`): 95 errors — expects 82 packages and finds 134, places
  `RoutingOverlay`/`Placement` in the `application` role while the installed Profile declares them in `candidateCatalog`,
  and flags retired markers (the old jobs API route in the frontend, the former language name and the old project
  file name).
- `experimentation/icsoc/generator/tests/test_generator.py` (CI job `test`, when the dataset is materialized): the generator
  writes Placement under `application`; the compiler refuses it. Also fails on 014e43a.

## 9. Rules

- Red before green for every fix/feature; keep the failing output.
- No new skips or xfails; SQLite-only coverage of locking code must be declared as such.
- Report only executed results, with SHA; otherwise `NOT EXECUTED`.
- Flaky tests are quarantined only through `docs/qa/FLAKY_TESTS.md` with an owner and a deadline.

## 10. CI (`.github/workflows/ci.yml`)

- **Change detection.** The `changes` job runs `tools/ci_changes.py` and outputs four areas: `e2e`, `bim`, `engines`,
  `gateway`. On pull requests the jobs of an unchanged area are skipped. A push to `develop`, a manual dispatch, a
  change to `ci.yml` or `tools/ci_*.py`, a path in no known area or a git error run everything. A pull request with no
  changed file (empty diff) also runs every area. Root `LICENSE`, `THIRD_PARTY_NOTICES.md`, the vendored BPMN XSD
  files and any `instance.json` run `bim` and `gateway` (the bim-core tests read them).
- **Required check.** Require only `ci-required` (`tools/ci_required.py`): a skipped area passes, a failed or cancelled
  job does not. An always-on job (`lab`, `bim-corpus`, `frontend` and the like) that is skipped fails `ci-required`.
- **Shards.** Playwright project `mocked` runs in three jobs `frontend-e2e`; the UI acceptance runner stays in
  `frontend`. Gateway unit tests run natively in two jobs `gateway-unit`, balanced by file size in `tools/ci_shard.py`; `test` keeps
  the Docker integration, ICSOC and OpenAPI snapshot steps. `bim-toolchain` runs one job per package (`bim-core`,
  `bim-service`, `bim-client`); the goldens run in the `bim-core` job.
- **Concurrency.** A new push to a pull request cancels its older run; a newer push to `develop` cancels the older
  `develop` push run; manual runs are never cancelled.
- **Full run by hand.** Actions > Continuous Integration > Run workflow (`workflow_dispatch`).
- **One shard locally.** Gateway unit tests, shard 1 of 2, as `ci.yml` runs it (the shard script prints paths from the
  repository root, pytest runs in `openbinding-gateway`, so the prefix is stripped):
  `cd openbinding-gateway; files=$(python3 ../tools/ci_shard.py --shard 1/2 --root openbinding-gateway/tests); .venv/bin/python -m pytest -p no:cacheprovider ${files//openbinding-gateway\//}`
  (use `uv run --locked --extra test pytest` in place of `.venv/bin/python -m pytest` without the venv). Playwright:
  `cd frontend && pnpm exec playwright test --project=mocked --shard=1/3`.
