# Intake: ci-speed (reduce PR CI time, find failures in the lab first)

- Origin: owner request `own-3c723859ce6c4fb1a14b385d5a9cd0b9` (2026-10-26): reduce PR CI time and discover failures in
  the lab, not on GitHub.
- Owner facts (last 100 runs): PR CI median 16.6 min, max 28 min, about 52 runner-minutes per run, about 10 runs per
  merged PR. Slow steps: `frontend` "Run Playground browser tests" 13.4 min, `test` "Run unit tests" 11.8 min (+2.2 min
  "Build and start services"), `bim-toolchain` package tests 9.1 min; every other step under 1.5 min.
- Base of this intake: `46068015`. This task edits no workflow and no code. Facts carry file:line; estimates are
  labelled as estimates; external facts carry the lookup sources (section 8).

## 1. Verified facts

### 1.1 The workflow (`.github/workflows/ci.yml`)
- Triggers: `pull_request` into `main`/`develop`, `push` to `develop`, `workflow_dispatch` (`ci.yml:3-8`). No path filter.
- Concurrency: only push runs share a group and cancel; every PR and manual run gets its own group by run id
  (`ci.yml:10-13`). **A new push to a PR does not cancel the PR's older run.**
- Nine jobs, all in parallel, no `needs`:
  | Job | Lines | timeout-minutes | Heavy steps |
  |---|---|---|---|
  | `bim-corpus` | `:24-76` | 45 (`:26`) | corpus compile `--expected 83 --jobs 4` (`:55-56`), deterministic builds (`:64-76`) |
  | `bim-toolchain` | `:81-124` | 45 (`:83`) | one pytest over 3 packages, 2 `--deselect` (`:114-118`); goldens (`:120-124`) |
  | `lab` | `:128-164` | 30 (`:130`) | `pytest lab/tests -q` (`:151-152`), API acceptance (`:155-157`), import-linter report-only (`:160-164`) |
  | `openspec` | `:168-191` | 10 (`:170`) | validate, report-only (`:189-191`) |
  | `trace` | `:195-227` | 10 (`:197`) | OFT trace, report-only (`:220-227`) |
  | `engines` | `:232-265` | **none** | `mvn -B install` (`:254-258`), minizinc `pnpm test` (`:260-265`) |
  | `test` | `:267-347` | **none** | `docker compose up --build -d --wait gateway-dev worker-dev engine-multi-heuristic` (`:316-322`), unit tests in the container (`:324-327`), ICSOC generator (`:329-330`), OpenAPI snapshot (`:335-336`), integration (`:338-339`) |
  | `frontend` | `:349-397` | **none** | lint + vitest (`:370-374`), build (`:376-378`), changelog PR-only (`:382-384`), `playwright install --with-deps chromium` (`:386-388`), `playwright test --project=mocked` (`:390-392`), UI acceptance (`:395-397`) |
- Caches: uv cache on in `bim-corpus`, `bim-toolchain`, `lab` (`:45-50`, `:98-103`, `:141-146`); maven cache in
  `engines` (`:247`). **No pnpm cache** (`frontend` `:357-368`, `engines` `:249-265`), **no Docker layer cache**
  (`test` builds images with `--build`, `:322`), no Playwright browser cache (`:386-388`).
- The unit suite runs inside `gateway-dev` with the whole checkout mounted read-only (`ci.yml:324-327`,
  `docker-compose.yml:125-139`); `test` is a wrapper around pytest (`openbinding-gateway/Dockerfile:68-69`).
- Nightly: `nightly.yml:14-16` (cron `17 3 * * *`) dispatches `ci.yml` on `develop` (`nightly.yml:29`); it fires only
  once the file is on `main` (`nightly.yml:3-4`).

### 1.2 Tests and specs that pin the workflow (every workflow slice must change them in the same PR)
- `lab/tests/test_ci_triggers.py`: push has no `paths` filter (`:52-54`); `pull_request` is exactly
  `{branches: [main, develop]}` (`:55-56`, text check `:66`); **no job may have a job-level `if`** (`:57-58`, `:105-106`);
  concurrency group fixed (`:74-80`); no job-level `permissions` (`:90-91`); no step `if` with `github.event_name`
  except the changelog step (`:108-112`).
- `lab/tests/test_ci_gate_tooling.py`: **allowed actions are exactly** `checkout@v4`, `setup-python@v5`,
  `setup-uv@v6`, `setup-java@v4`, `setup-node@v4` (`:40-46`, `:245-248`), so `dorny/paths-filter`, `actions/cache`,
  `docker/*` actions are refused today; `bim-toolchain` has no `if`, no `paths` filter on `pull_request`, and runs exactly
  the three package dirs in one command (`:424-447`); the UI acceptance runner is the **last step of job `frontend`**,
  after `playwright install` (`:597-604`); API runner order in `lab` (`:542-549`); `_fails_job` forbids step `if`
  unless allowed (`:78-93`).
- `openbinding-gateway/tests/test_ci_starts_a_job_consumer.py`: reads job `test`, steps named "Build and start
  services" and "Show service logs on failure" (`:48-52`, `:83-116`).
- `openbinding-gateway/tests/test_omg_xsd_wiring.py:170-177`: step order in `bim-corpus`.
- Requirements behind them (open changes, not yet archived into `openspec/specs/`; no `gate-tooling` capability exists
  under `openspec/specs/`):
  - `req~ci-develop-push~1`: push runs all jobs; scenario "no job has an `if:` condition that skips it on a `push`
    event" and "`pull_request` ... no `paths` filter" (`openspec/changes/ci-develop-triggers/specs/gate-tooling/spec.md:3-21`).
  - `req~ci-develop-push-concurrency~1`: "SHALL NOT cancel pull-request or manual runs" (same file `:23-41`).
  - `req~gate-tooling-bim-toolchain-tests~1`: "with no path filter", one pytest over the three packages
    (`openspec/changes/m03-gate-tooling/specs/gate-tooling/spec.md:195-208`).

### 1.3 What each suite reads (it decides which paths may skip a job)
- The gateway unit suite reads far outside `openbinding-gateway/`: `frontend/` (`tests/test_b5_corpus.py`,
  `test_b2_resolve_urls.py`, `test_b6_workbench_package.py`, `test_b7_form_flows.py`), `docs/` (`test_openapi_contract.py`,
  `test_b3_openapi.py`, `test_b3_public_read.py`, `test_pg_harness.py`, `test_process_probe.py`), `.github/`
  (`test_omg_xsd_wiring.py`, `test_ci_starts_a_job_consumer.py`), compose files, `.env.example`, `tools/`, `space/`,
  `experimentation/`, `pricings/` (`test_no_local_pricing.py`, `test_docker_context.py`, `test_container_hardening.py`),
  `examples/`, `schemas/`, `bim-toolchain/` (`test_bim_*`). Source: grep of `REPO_ROOT / "` in
  `openbinding-gateway/tests`. **Consequence: a path filter on the gateway suite can skip it only for docs-only or
  spec-only PRs.**
- `bim-toolchain` tests and goldens read `bim-toolchain/**` plus the corpus under the directory that contains
  `bim-toolchain/` (`BIM_CORPUS_ROOT` default: `bim-toolchain/tools/baseline_core.py:35,139`,
  `bim-toolchain/packages/bim-client/tests/client_support.py:28-29`); `bim-corpus` compiles literature, campaign,
  generator and engine-fixture packages (`ci.yml:19-23`).
- The mocked Playwright project serves `frontend/` with Vite and answers the API in the specs
  (`frontend/playwright.config.ts:4-11`, `:25-30`, `:39-43`); no import from outside `frontend/` was found in
  `frontend/src` or `frontend/e2e`. 23 mocked spec files and 8 live specs (glob `frontend/e2e/**/*.spec.ts`).
- `fullyParallel: true`, `retries: 0`, no `workers` set (`playwright.config.ts:18-20`): Playwright defaults to half the
  logical cores (lookup L5), i.e. 2 workers on the 4-vCPU public runner (lookup L1).
- Every PR changes `frontend/src/content/changelog.generated.json` (final `chore(changelog)` commit,
  `CONTRIBUTING.md:36-38`; generated path `.agentic/project.yaml:27`). An area rule must ignore this file or every PR
  runs the e2e shards.
- PRs are opened as drafts from the first commit (`CONTRIBUTING.md:43`) and `pull_request` runs on drafts, so every
  push of a draft runs the full CI (default `pull_request` activity types; `ci.yml:4-5` sets none).
- No `pytest-xdist` in the gateway's `test` extra (`openbinding-gateway/pyproject.toml:47-55`); `addopts` excludes
  `integration` (`:85-90`).

### 1.4 Factory defaults (`.agentic/project.yaml`) and drift against CI
| Entry | project.yaml | CI | Drift |
|---|---|---|---|
| `bim-corpus` | `--expected "82"` (`:51`) | `--expected 83` (`ci.yml:56`) | **lab check fails or disagrees** |
| `bim-toolchain` | `python -m pytest ... packages/*/tests tools`, no `--deselect`, no `-p no:cacheprovider` (`:50`) | gateway venv Python, 3 package dirs, 2 `--deselect` (`ci.yml:114-118`) | different test set; timing tests not deselected |
| bim goldens | absent from G5 | `tools/baseline_core.py --check` (`ci.yml:120-124`) | missing in lab |
| `frontend-e2e-mocked` | `pnpm test:e2e` (`:59`) = `playwright test` (`frontend/package.json:17`), **all projects incl. `live`** | `--project=mocked` (`ci.yml:392`) | lab runs live specs too |
| `frontend-unit`, `frontend-e2e-mocked` | `needs: [node20, ...]` (`:58-59`) | Node 22 (`ci.yml:357-361`); `engines.node >=22.22.2` (`frontend/package.json:7-8`) | wrong runtime named |
| API / UI acceptance runners | absent | `ci.yml:155-157`, `:395-397` | missing in lab |
| XSD `--check`, deterministic builds | absent | `ci.yml:35-38`, `:64-76` | missing in lab |
| `when_paths` | only `gateway-postgres` (`:46`), `engine-minizinc-real` (`:57`), `qacobench-unit` (`:60`) | — | every other G5 check runs on every change |
- `.agentic/**` is R11 owner-only (`:137-139`); `.github/**` is R10 high (`:134-136`).
- Check timeouts are 60..1800 s (factory qa-checks); **1800 is the ceiling**, and the full gateway suite already needs
  it (owner), so if it grows it must be split in two checks (precedent: `tests/test_[a-m]*.py` / `tests/test_[n-z]*.py
  tests/concurrency`, `docs/qa/JOINT_STATUS.md:167-168`).

### 1.5 Lab durations on record (qa_run unless noted; none of the mocked Playwright run is on record)
| Suite (project.yaml name) | Lab duration | Evidence |
|---|---|---|
| gateway unit `a-m` + `n-z`+concurrency (`gateway-unit`) | 238.54 s + 68.27 s = 306.8 s | `docs/qa/JOINT_STATUS.md:167-168` (`d908d240`) |
| gateway unit + `lab/tests` | 194.73 s | `docs/qa/JOINT_STATUS.md:158` (`5aebc7c8`) |
| gateway unit `a-m` / `n-z` | 231.95 s / 72.46 s | `docs/qa/FINAL_VALIDATION.md:210,223` |
| PostgreSQL concurrency (`gateway-postgres`) | 12 s; 24.31 s (113 tests) | `docs/qa/PG_HARNESS.md:10`; `docs/qa/JOINT_STATUS.md:24` |
| `bim-toolchain` | 54.07 s; 159.60 s; 370.36 s; 408.89 s (B8 timing tests vary) | `JOINT_STATUS.md:158,169`; `FINAL_VALIDATION.md:293,241` |
| ICSOC generator (`icsoc-generator`) | 14.93 s | `docs/agent-work/icsoc-ci-round8/report.md:79` |
| frontend install / vitest / build | 1.5 s / 237.51 s / 9.0-9.34 s | `JOINT_STATUS.md:171,174`; `FINAL_VALIDATION.md:260,279` |
| `frontend-e2e-mocked`, `gateway-integration`, `engines-jvm`, `lab-static`, `bim-corpus`, eslint | **not measured** | none found; slice S1 measures them |
- The lab runs the gateway suite in roughly 5 min against 11.8 min on GitHub, and bim-toolchain in 1-7 min against
  9.1 min: a large part of GitHub's time is the 4-vCPU runner and setup, not the tests alone (estimate).

## 2. Design summary

1. **Lab first (the cheap lever, no token needed).** About 10 runs per merged PR means about 520 runner-minutes per
   merged PR. The factory runs the affected-path gate (section 3) through qa_run before every push and before posting
   `nipogi/gates`, and pushes code and the changelog commit together. Target: at most 4 runs per merged PR.
2. **Change detection without new actions and without pending checks.** A `changes` job runs
   `python3 tools/ci_changes.py` (repo script, git diff of `pull_request.base.sha`..`HEAD` on a full checkout) and sets
   one output per area. On `push` and `workflow_dispatch` every output is `true`, so develop and the nightly keep full
   coverage. Rules fail safe: a changed file outside every known area, or a change to `ci.yml` or `tools/ci_*.py`,
   sets every area to `true`; a git error fails the job. Heavy jobs get a job-level
   `if: needs.changes.outputs.<area> == 'true'`. A job skipped by `if` reports Success, while a workflow skipped by
   `paths` leaves required checks Pending (lookup L2), so no `on.paths` filter is used.
3. **One required check.** `ci-required` (`needs:` every job, `if: always()`) runs `python3 tools/ci_required.py` with
   `NEEDS: ${{ toJSON(needs) }}` in `env`. It fails on any `failure` or `cancelled`, on a failed `changes` job, and
   on a skipped job whose area output was `true`. The owner makes it the only required check (CRP-1), so matrix and
   renamed jobs never leave a check pending.
4. **Shard and parallelise the three slow steps**: Playwright mocked in 3 jobs (`--shard=i/3`; with `fullyParallel` the
   split is per test, lookup L3); gateway unit tests out of the container into 2 native uv jobs split by file
   (`tools/ci_shard.py`, a partition proven by a test), so the compose job keeps only integration, ICSOC and OpenAPI;
   bim-toolchain one job per package (CRP-8). pytest-xdist is not the first choice: it needs a lockfile change (CRP-5),
   and the bim-service B8 tests measure timing (`ci.yml:108-113`).
5. **Hygiene**: `timeout-minutes` on `engines`, `test`, `frontend` (none today); cancel superseded PR runs (CRP-3).
6. **Areas (starting point; S2 proves them with tests over section 1.3):**
   - `e2e`: `frontend/**` except `frontend/src/content/changelog.generated.json` and `frontend/**/*.md`.
   - `bim`: `bim-toolchain/**`, `examples/**`, `schemas/**`, `datasets/**`, `experimentation/**`, `engines/**` fixtures,
     `tools/*bim*`, `openbinding-gateway/pyproject.toml`, `openbinding-gateway/uv.lock`.
   - `engines`: `engines/**`, `schemas/bim/**`, `tools/check_bim_guard.py`.
   - `gateway`: everything except `docs/agent-work/**`, `openspec/**`, root `*.md` not read by tests (S2 lists them),
     `acceptance/ui/**`, `frontend/e2e/**`.
   - Always on (cheap, under 1.5 min per step): `bim-corpus`, `lab`, `openspec`, `trace`, `frontend` (lint, vitest,
     build, changelog, UI acceptance).
7. **Never self-hosted runners**: the repository is public; GitHub-hosted standard runners are free and unlimited for
   public repositories, 4 vCPU / 16 GB (lookup L1).

## 3. Local gate: what the lab runs before a push or before posting `nipogi/gates`

Rules: cheap checks first, heavy ones last (at most two checks run at once in the lab); a check maps to the CI step
named; durations from section 1.5. Factory names refer to `.agentic/project.yaml` (corrected per CRP-6).

| Changed paths | Checks (project.yaml name → CI step) | Lab time |
|---|---|---|
| any | `changelog` (`:83` → `ci.yml:382-384`), `compose-config` (`:81` → `:301-302`), `bim-guard` (`:52` → `:239-240`) | seconds (not measured) |
| `openbinding-gateway/**`, `schemas/**`, `examples/**`, `docs/openapi.json`, `docs/**` read by tests, `tools/**`, `pricings/**`, `space/**`, `experimentation/**`, compose files, `.env.example`, `.github/**`, `frontend/src/**` | `ruff-gateway` (`:76`), `openapi-snapshot` (`:66` → `ci.yml:335-336`), `gateway-unit` (`:44` → `:324-327`, **timeout 1800**) | ≈ 5 min (306.8 s) |
| `openbinding-gateway/src/openbinding_gateway/{routes,jobs,services,worker*,v1}/**`, `engines/**`, `docker-compose.yml`, Dockerfiles | + `gateway-integration` (`:47` → `:338-339`), `icsoc-generator` (`:48` → `:329-330`); Dockerfile or compose change: `gateway-unit-compose` (`:45`) | integration not measured; ICSOC 15 s |
| PG paths (`:46` `when_paths`) | + `gateway-postgres` | 12-24 s |
| `lab/**`, `.github/**`, `acceptance/api/**`, `TESTING.md`, `acceptance/README.md` | `lab-static` (`:49` → `ci.yml:151-152`), API acceptance (new entry → `:155-157`) | not measured |
| `bim` area (section 2.6) | `bim-toolchain` (CI argv, CRP-6) + goldens + `bim-corpus` (`--expected 83`) + `shared-examples` + `bim-diagrams` (`:50-54` → `ci.yml:55-62,114-124`), **timeout 1800** | 1-7 min (+ corpus not measured) |
| `engines/**` | `engines-jvm` (`:55` → `:254-258`), `engine-minizinc` (`:56` → `:260-265`) | not measured |
| `frontend/**` | `eslint` (`:78`), `frontend-unit` (`:58`), `typecheck-build` (`:79`) | ≈ 4.2 min |
| `e2e` area | `frontend-e2e-mocked` with `--project=mocked` (`:59` → `ci.yml:390-392`), UI acceptance (new → `:395-397`) | **not measured** (S1) |
| `openspec/**` | `openspec validate <change> --strict` (G1, `:34`) | seconds |

Proposed default-check changes (R11, owner): CRP-6 lists them. Factory changes (coordinator, not this project):
F1 run this table through qa_run before every push and before posting `nipogi/gates`, and record the run ids in the
status; F2 the pr-steward pushes code and the changelog commit in one push and does not push a draft while the gate
is red; F3 allow `timeout_seconds` per default check (1800 for `gateway-unit`, `bim-toolchain`, `frontend-e2e-mocked`);
F4 `when_paths` on default checks drives the table above.

## 4. Measurement (before and after, same metrics)

Window: the last 100 completed `pull_request` runs of `ci.yml` into `develop` (before: owner's figures of 2026-10-26;
after: the 100 runs after the last slice merges, and the next 30 runs after each slice for a per-slice delta).
- M1 wall-clock per run: `run_started_at` → `updated_at`; median, p90 and max.
- M2 runner-minutes per run: sum of job durations (`completed_at - started_at`), raw and rounded up per job.
- M3 runs per merged PR: PR runs ÷ merged PRs in the window; M4 = M2 × M3, runner-minutes per merged PR.
- M5 per step: median of the three slow steps; after the change, the sum (runner) and max (wall) over their shards.
- M6 share of PR runs that fail, and share of those whose failing suite the lab gate had run (goal: discover in lab).
- M7 share of PRs per area (from `tools/ci_changes.py` over the last 100 first-parent commits of `develop`, S2 check 3).
- L1 lab: qa_run duration of every section 3 check (S1 baseline, then per slice).

## 5. Expected savings (estimates, to be replaced by M1-M7)

| Job / step | Before (GitHub, owner) | After, when it runs (estimate) | Skipped on a PR when | Wall effect | Runner-min per run |
|---|---|---|---|---|---|
| `frontend` Playwright mocked | 13.4 min, one job | 3 shards ≈ 4.5 test + ≈ 1.5 setup each | `e2e` area untouched | e2e path ≈ 6 min (was ≈ 16.6) | +≈ 3 when run; −≈ 15 when skipped |
| `frontend` rest | ≈ 3.2 min (16.6 − 13.4) | unchanged | never | ≈ 3-4 min | 0 |
| `test` unit tests | 11.8 min | 2 native shards ≈ 6 + ≈ 1 setup each | `gateway` area untouched (docs/spec-only) | test path ≈ 7 min | +≈ 2; with xdist (CRP-5b) −≈ 7 |
| `test` build and start services | 2.2 min | unchanged (integration needs it) | `gateway` untouched | 0 | 0 (−2.2 only with a layer cache, CRP-7) |
| `bim-toolchain` tests | 9.1 min | unchanged (S3); per package ≈ max package (S6) | `bim` area untouched | ≈ −(9.1 − max package) | −≈ 10 when skipped |
| `engines` | steps < 1.5 min | unchanged | `engines` untouched | 0 | −(job) when skipped |
| superseded PR runs | never cancelled (`ci.yml:10-13`) | cancelled (CRP-3) | — | 0 | −remaining minutes of each superseded run |
| `changes` + `ci-required` | — | ≈ 0.5 runner-min | — | +≈ 0.3 min | +≈ 0.5 |

Illustrative per-run outcome (estimate): every area touched: wall ≈ 8-9 min (from 16.6), runner ≈ 58 min (from 52);
gateway-only PR: wall ≈ 8-9, runner ≈ 29; frontend-only PR: wall ≈ 8-9 (gateway tests read `frontend/`), runner ≈ 47;
docs/spec-only PR: wall ≈ 3, runner < 10. Per merged PR (assumes 4 runs, runner ≈ 35 average): ≈ 140 runner-min (from ≈ 520).

## 6. Slices (`.github/workflows/ci.yml` is shared: S3-S7 are serial; S2 and S5a run in parallel with S0/S1)

Every workflow push needs a token with **Workflows: write**, which only the owner provides (CRP-4). Files needing it:
`.github/workflows/ci.yml` only (`nightly.yml` is unchanged). Gates for the CI slices: G3, G5, G9, G10, G11 (high panel,
R10). Common checks (from the worktree root): C0 `["bash","-c","cd openbinding-gateway && uv sync --locked --extra test"]`;
C1 `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests"]`;
C2 `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider tests/test_ci_starts_a_job_consumer.py tests/test_omg_xsd_wiring.py"]`;
C3 `["openbinding-gateway/.venv/bin/python","-c","import yaml; yaml.safe_load(open('.github/workflows/ci.yml', encoding='utf-8'))"]`.

| Slice | Role | Owned files | Depends on | Risk | Turns |
|---|---|---|---|---|---|
| S0 spec | specifier | `openspec/changes/ci-speed/**` | archive of `ci-develop-triggers`, `ci-develop-nightly`, `m03-gate-tooling`; CRP-2 | low (docs) | 40 |
| S1 lab baseline | explorer | `docs/agent-work/ci-speed/baseline.md` | — | low (no code) | 30 |
| S2 change detection script | implementer | `tools/ci_changes.py`, `tools/ci_required.py`, `lab/tests/test_ci_changes.py` | S0 | medium (decides what runs) | 50 |
| S5a shard script | implementer | `tools/ci_shard.py`, `lab/tests/test_ci_shard.py` | S0 | low | 30 |
| S3 `changes` + `ci-required` + timeouts | implementer + owner token | `.github/workflows/ci.yml`, `lab/tests/test_ci_triggers.py`, `lab/tests/test_ci_gate_tooling.py` | S0, S2, CRP-1, CRP-2, CRP-4 | high (R10) | 50 |
| S4 Playwright shards | implementer + token | `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py` | S3 merged | high (R10) | 40 |
| S5 gateway unit shards | implementer + token | `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py`, `openbinding-gateway/tests/test_ci_starts_a_job_consumer.py` | S4 merged, S5a | high (R10) | 50 |
| S6 bim-toolchain per package | implementer + token | `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py` | S5 merged, CRP-8 | high (R10, R7 read) | 40 |
| S7 PR concurrency | implementer + token | `.github/workflows/ci.yml`, `lab/tests/test_ci_triggers.py` | S6 merged, CRP-3 | high (R10) | 20 |
| S8 factory defaults | owner (R11) | `.agentic/project.yaml` | CRP-6; after S4, S5 | owner | — |
| S9 docs | doc-steward | `TESTING.md`, `AGENTS.md` (CI lines), `CONTRIBUTING.md` (draft rule, only with CRP-9) | S7 | low | 20 |

Sizes (non-test lines, estimates): S2 ≈ 180, S5a ≈ 60, S3 ≈ 70, S4 ≈ 40, S5 ≈ 60, S6 ≈ 40, S7 ≈ 5. All under 300.

### S0 spec
New capability delta in change `ci-speed`, EARS, revisions: `req~ci-develop-push~2` (PR runs may skip a job only
through `needs.changes` outputs; push and dispatch run every job), `req~ci-develop-push-concurrency~2` (with CRP-3a),
`req~gate-tooling-bim-toolchain-tests~2` (area-gated on PRs; one job per package with CRP-8a); added
`req~ci-speed-change-detection~1`, `req~ci-speed-required-aggregate~1`, `req~ci-speed-e2e-shards~1`,
`req~ci-speed-gateway-unit-shards~1`, `req~ci-speed-job-timeouts~1`. Check: `["openspec","validate","ci-speed","--strict"]`.

### S1 lab baseline (L1 and the missing durations)
Each check prints `elapsed N s`; timeout 1800 for B1-B4.
- B0 `["bash","-c","cd frontend && pnpm install --frozen-lockfile"]`
- B1 `["bash","-c","set -euo pipefail; cd frontend; s=$(date +%s); pnpm exec playwright test --project=mocked --reporter=line > \"$TMPDIR/e2e.txt\" 2>&1; tail -n 40 \"$TMPDIR/e2e.txt\"; echo \"elapsed $(( $(date +%s) - s )) s\""]`
- B2 `["bash","-c","set -euo pipefail; cd openbinding-gateway; s=$(date +%s); uv run --locked --extra test pytest -q -p no:cacheprovider --durations=40 > \"$TMPDIR/u.txt\" 2>&1; tail -n 80 \"$TMPDIR/u.txt\"; echo \"elapsed $(( $(date +%s) - s )) s\""]`
- B3 `["bash","-c","set -euo pipefail; cd bim-toolchain; s=$(date +%s); for p in bim-core bim-service bim-client; do t=$(date +%s); PYTHONPATH=packages/bim-core/src:packages/bim-service/src:packages/bim-client/src ../openbinding-gateway/.venv/bin/python -m pytest -q -p no:cacheprovider --rootdir=. packages/$p/tests --deselect packages/bim-service/tests/analysis/test_analysis_b8_evidence.py::test_the_throughput_cost_of_a_short_switch_interval --deselect 'packages/bim-service/tests/analysis/test_analysis_b8_probe.py::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]' > \"$TMPDIR/$p.txt\" 2>&1; tail -n 3 \"$TMPDIR/$p.txt\"; echo \"$p $(( $(date +%s) - t )) s\"; done; echo \"elapsed $(( $(date +%s) - s )) s\""]`
- B4 `["bash","-c","set -euo pipefail; s=$(date +%s); cd openbinding-gateway; uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests; echo \"elapsed $(( $(date +%s) - s )) s\""]`
- B5 `["bash","-c","set -euo pipefail; s=$(date +%s); python3 bim-toolchain/tools/xsd_inventory.py --ensure; openbinding-gateway/.venv/bin/python tools/check_bim_corpus.py --expected 83 --jobs 4; echo \"elapsed $(( $(date +%s) - s )) s\""]`
- Output: `baseline.md` with one row per check (command, result line, elapsed, head).

### S2 change detection script
`tools/ci_changes.py --base <sha> --head <sha> --event <name>` prints `area=true|false` (and appends to
`$GITHUB_OUTPUT` when set); `tools/ci_required.py` reads `NEEDS` and the `changes` outputs. Tests: area rules on
fixtures (changelog-only PR → only always-on jobs; unknown path → all true; `ci.yml` change → all true; push → all
true); a test that every `REPO_ROOT / "<dir>"` read by `openbinding-gateway/tests` falls in the `gateway` area; the
aggregator fails on `failure`, `cancelled`, failed `changes`, or skipped-while-true. Checks: C0; red_before
`{"argv":["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests/test_ci_changes.py"],"type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError","overlay":["lab/tests/test_ci_changes.py"]}`;
C1; M7 `["bash","-c","set -euo pipefail; for c in $(git rev-list --first-parent -n 100 HEAD); do python3 tools/ci_changes.py --base \"$c^\" --head \"$c\" --event pull_request; echo; done > \"$TMPDIR/a.txt\"; for k in e2e bim engines gateway; do echo \"$k $(grep -c \"^$k=true\" \"$TMPDIR/a.txt\")\"; done"]`
(needs git history in the check; otherwise the coordinator runs it).

### S5a shard script
`tools/ci_shard.py --shard i/n [--root openbinding-gateway/tests]` prints test files, sorted, assigned to balance
the S1 `--durations` totals; the test asserts the shards partition `pytest --collect-only -q` of the suite. Checks: C0;
red_before on `lab/tests/test_ci_shard.py` as in S2; C1.

### S3 `changes`, `ci-required`, timeouts (token)
New jobs `changes` (checkout `fetch-depth: 0`, `timeout-minutes: 5`) and `ci-required`; job-level `if` on
`bim-toolchain` and `engines`; `timeout-minutes` 30 on `engines`, 45 on `test` and `frontend`; lab tests updated to the
S0 revisions. Checks: C0, red_before on the changed lab tests, C1, C2, C3; GitHub proof (pr-steward `ci_status`):
the PR run shows `ci-required` success, and a docs-only follow-up PR shows `bim-toolchain` and `engines` skipped with
`ci-required` success.

### S4 Playwright shards (token)
New job `frontend-e2e` (`if: needs.changes.outputs.e2e == 'true'`, `strategy.fail-fast: false`, matrix
`shard: [1, 2, 3]`): checkout, Node 22, `corepack enable`, `pnpm install --frozen-lockfile`, `playwright install
--with-deps chromium`, `pnpm exec playwright test --project=mocked --shard=${{ matrix.shard }}/3`; the mocked step
leaves `frontend` (the UI acceptance runner stays its last step, `test_ci_gate_tooling.py:604`). Checks: C0, C1, C3;
partition in the lab: `["bash","-c","set -euo pipefail; cd frontend; t=0; for i in 1 2 3; do n=$(pnpm exec playwright test --project=mocked --list --shard=$i/3 | grep -oE 'Total: [0-9]+' | grep -oE '[0-9]+'); t=$((t+n)); done; a=$(pnpm exec playwright test --project=mocked --list | grep -oE 'Total: [0-9]+' | grep -oE '[0-9]+'); echo \"shards $t all $a\"; test \"$t\" -eq \"$a\""]`;
one shard run timed as B1 with `--shard=1/3`. GitHub: shard durations from `ci_status`.

### S5 gateway unit shards (token)
New job `gateway-unit` (matrix `shard: [1, 2]`, `if` on `gateway`): checkout, XSD `--ensure`, setup-python 3.11,
setup-uv 0.8.14 with cache, ICSOC dataset step (moved from `test`, `ci.yml:307-314`, kept in `test` too for
integration), `uv sync --locked --project openbinding-gateway --extra test`, pytest over `tools/ci_shard.py --shard
i/2` with `OPENBINDING_REPO_ROOT` set to the checkout. `test` loses "Run unit tests" (`ci.yml:324-327`) only.
Checks: C0, C1, C2, C3, both shards in the lab (B2 form with the shard file list), timeout 1800.

### S6 bim-toolchain per package (token, CRP-8a)
Matrix over the three packages, `--deselect` options kept on bim-service; goldens in the first package job. Checks:
C0, C1, C3, B3.

### S7 PR concurrency (token, CRP-3a)
`group: ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.ref || github.event.pull_request.number || github.run_id }}`,
`cancel-in-progress: ${{ github.event_name != 'workflow_dispatch' }}`. Checks: C0, C1, C3.

## 7. Owner decisions (CRPs)
- CRP-1 required checks: which checks are required on `develop` and `main` today (branch protection is not readable
  from the repository). (a) replace them with `ci-required` only, recommended; (b) keep today's names (then no job can
  be renamed, split or skipped); (c) a ruleset requiring both during a transition.
- CRP-2 PR-only skipping: (a) skip by area on PRs, push/dispatch/nightly run all, recommended; (b) only sharding and
  parallelism, no skipping (saves wall, not runner-minutes).
- CRP-3 cancel superseded PR runs (changes `req~ci-develop-push-concurrency~1`): (a) yes, recommended; (b) no.
- CRP-4 workflow token: (a) a fine-grained token limited to this repository with Contents and Workflows write, valid
  for the S3-S7 window, given to the pr-steward, recommended; (b) the owner applies each S3-S7 patch; (c) postpone.
- CRP-5 gateway parallelism: (a) native 2-shard job by file, no dependency change, recommended first; (b) pytest-xdist
  in the `test` extra (pyproject, `uv.lock`, image; locking needs PyPI, which `.agentic/project.yaml:176` lists under
  `forbidden_remote_calls`; R7 high); (c) both.
- CRP-6 factory defaults (R11): `bim-corpus` `--expected 83`; `bim-toolchain` = CI argv + goldens entry; `frontend-*`
  `needs: [node22, ...]`; `frontend-e2e-mocked` argv `[pnpm, exec, playwright, test, --project=mocked]`; add API and
  UI acceptance runners, XSD `--check`, deterministic builds; `when_paths` per section 3. (a) apply after S4/S5,
  recommended; (b) only the drift fixes now.
- CRP-7 Docker layer cache: `type=gha` needs the runtime token exposed by an action such as
  `crazy-max/ghaction-github-runtime` (lookup L4), a new third-party action (R10). (a) no, recommended; (b) yes, later.
- CRP-8 bim-toolchain per-package jobs (revises the one-command scenario): (a) yes after S1 shows a package split
  worth it; (b) skipping only.
- CRP-9 drafts: (a) the factory pushes once the lab gate is green (no workflow change), recommended; (b) `changes`
  sets heavy areas false on draft PRs and `ready_for_review` re-runs (changes the pinned `pull_request` block).
- Ruled out: self-hosted runners (public repository); `on.pull_request.paths` filters (required checks stay pending,
  lookup L2); caching Playwright browsers (the Playwright docs advise against it, lookup L3).

## 8. Lookups (data, cited)
- L1 runners: 4 vCPU / 16 GB for public repos, free and unlimited; concurrency Free 20, Team 60 (medium confidence):
  docs.github.com/en/actions/reference/runners/github-hosted-runners, .../billing/.../about-billing-for-github-actions,
  docs.github.com/en/actions/reference/limits.
- L2 required checks: `paths`-skipped workflow → Pending, blocks; job skipped by `if` → Success; aggregator with
  `if: always()` must fail explicitly on `failure`/`cancelled`: docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks.
- L3 Playwright: `fullyParallel` shards per test; blob + `merge-reports`; browsers in `~/.cache/ms-playwright`, OS deps
  not cacheable: playwright.dev/docs/test-sharding, /docs/ci, /docs/browsers.
- L4 Docker `type=gha` in a plain `run:` step needs `ACTIONS_RUNTIME_TOKEN`/`ACTIONS_RESULTS_URL` exposed (e.g.
  `crazy-max/ghaction-github-runtime`); Compose `type=gha` not documented: docs.docker.com/build/cache/backends/gha/.
- L5 Playwright `workers` "Defaults to half of the number of logical CPU cores": playwright.dev/docs/api/class-testconfig.
- L6 pytest-xdist 3.8.0, pytest>=7; `loadfile`, `loadgroup`, `worksteal`; setup-node `cache: pnpm` needs pnpm on PATH
  first (example uses `pnpm/action-setup`, not in the allowed set): pypi.org/project/pytest-xdist/, github.com/actions/setup-node.
