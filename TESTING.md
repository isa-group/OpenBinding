Status: DRAFT for owner review (2026-10-21)

# TESTING — OpenBinding

How behaviour is proven in this repository. Commands are the ones CI (`.github/workflows/ci.yml`) and the existing
docs use; `AGENTS.md` §3 lists them per component. Counts are from `spec/baseline` (9b5be00), counted by file
inspection, not by running the suites.

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
| QACOBench (`experimentation/qacobench/`) | `test_qacobench.py` (registry/seed stability, resume key, evaluation, reconciliation) | `run.sh pilot` (2 instances × 3 engines) | full campaign (reference 1.1.1) | pytest, Docker Compose |

## 2. `acceptance/` layout (to be created)

```
acceptance/
  <capability>/
    <req-slug>.<ext>      # one file per requirement or scenario group; tagged [utest->req~<capability>-<slug>~N]
  README.md               # how to run, which runner per capability
```

- Written only by the test-designer from the spec and public interfaces (OpenAPI, BIM schemas, engine protocol,
  route registry); never by the implementer; frozen for the duration of a change (G4).
- Gateway acceptance tests are pytest against `create_app()` or the Compose stack; frontend acceptance tests are
  Playwright specs; engine acceptance tests speak `bim-engine/v1` over HTTP.

> OPEN QUESTION: one top-level `acceptance/` with per-component runners, or `acceptance/` inside each component?

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

- Mocked browser suite: `cd frontend && pnpm test:e2e` (CI).
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

## 8. Rules

- Red before green for every fix/feature; keep the failing output.
- No new skips or xfails; SQLite-only coverage of locking code must be declared as such.
- Report only executed results, with SHA; otherwise `NOT EXECUTED`.
- Flaky tests are quarantined only through `docs/qa/FLAKY_TESTS.md` with an owner and a deadline.
