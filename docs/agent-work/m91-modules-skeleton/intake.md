# Intake: m91-modules-skeleton (ROADMAP M9.1)

- Origin: owner request `own-033e9b12c03448b28e474e292072c32c` (2026-10-24): plan M9.1, the `app/`, `shared/`,
  `modules/` skeleton of the gateway with import-linter contracts, enforced for new modules only.
- Sources: `docs/ARCHITECTURE.md` §4, §4.2, §4.3, §14; ADR-0012, ADR-0017; `constitution.md` Article 6; `ROADMAP.md` M9.
- Behaviour-preserving: no runtime code moves, `docs/openapi.json` stays byte-identical, the legacy `.importlinter`
  and its report-only CI step stay as they are.
- Files held by other leads, never touched by any slice below: `openbinding-gateway/src/openbinding_gateway/services/citations.py`,
  `.../routes/resolve.py`, `.../routes/verifier.py`, `openbinding-gateway/tools/latency_probe.py`, `frontend/**`,
  `openspec/**`, `ROADMAP.md`.

## 1. Verified facts (file:line, read at the base of this task, head 99697d7e)

Target architecture
- Ten modules plus the `shared` kernel: `docs/ARCHITECTURE.md:119-131`.
- Layout `app/`, `shared/`, `modules/<module>/{domain,application,adapters/{http,persistence,<external>}}`:
  `docs/ARCHITECTURE.md:135-147`.
- Rules: `adapters → application → domain`, `domain` imports no framework or adapter (`:149`); other modules only
  through their `application` public API (`:150-151`); the module order `administration → publishing → laboratory →
  execution → engines | repository → language → collaboration → identity → plans → shared` (`:152-154`);
  enforcement is "import-linter contracts (layers per module, module independence) in G9, plus the existing
  `tests/test_architecture_layers.py` ratchets" (`:160-161`).
- Migration step 1: "Create `app/`, `shared/` and `modules/` with import-linter contracts; move nothing"
  (`docs/ARCHITECTURE.md:173`). Step 2: new capabilities land in modules, `plans` (M4) and the language registry (M5)
  first (`:174`). Step 3: moves keep `docs/openapi.json` byte-identical (`:175-177`).
- ROADMAP M9.1: "`app/`, `shared/`, `modules/` skeleton with import-linter contracts | contracts enforced for new
  modules" (`ROADMAP.md:184`). M9 first steps may run in parallel with M2 and M4 (`ROADMAP.md:29`). M4.2 creates the
  first real module, `plans` (`ROADMAP.md:123`).
- ADR-0017 (modular monolith) is **Proposed**, deciders: owner (`docs/adr/0017-modular-monolith-and-feature-sliced-frontend.md:1,5,7`);
  its consequence: "import-linter and ESLint boundaries become gate checks (G9)" (`:26`). ADR-0012 (layered gateway
  with ratchets) is Accepted (`docs/adr/0012-layered-gateway-with-ratchets.md:5,11-13`).
- Constitution 6.5 requires new backend code in `modules/<context>/{domain,application,adapters}`, cross-module
  imports only through `application`, a `domain` free of FastAPI, SQLAlchemy and HTTP clients
  (`constitution.md:67-69`); "GAP for 6.5–6.6: import-linter contracts for modules" (`constitution.md:78-79`).

Current layout
- Top-level packages of `openbinding_gateway`: `access, core, db, domain, generator, integrations, jobs, models,
  repositories, routes, security, services, space_client, v1, validation`, plus top-level modules `analysis_jobs,
  artifacts, cas, collaboration, job_dispatch, mailer, main, pricing_catalog, reports, sphere_client,
  sponsor_proposals, studies, study_jobs, telemetry, worker` (glob of `src/openbinding_gateway/*`).
- No `app`, `shared` or `modules` package exists, and nothing imports one: no match for
  `openbinding_gateway(\.| import )(app|shared|modules)\b` in the repository.
- `create_app` is at `openbinding-gateway/src/openbinding_gateway/main.py:315`, `app = create_app()` at `:1482`;
  the image runs `uvicorn openbinding_gateway.main:app` (`openbinding-gateway/Dockerfile:118`), so a subpackage
  `openbinding_gateway.app` does not clash with the attribute `main.app`.
- The image copies the whole `src/` (`openbinding-gateway/Dockerfile:39`); hatchling builds the package
  (`openbinding-gateway/pyproject.toml:92-94`), so new subpackages need no packaging change.

Existing import-linter set-up (M0.3)
- `openbinding-gateway/.importlinter:1-36`: root `openbinding_gateway`, three contracts: `layers`
  (`routes / services / repositories | integrations / db`), `no-routes`, `integrations`.
- `import-linter==2.15` in the `lint` dependency group only (`openbinding-gateway/pyproject.toml:96-99`).
- CI: job `lab`, last step "Check import contracts (report-only)", `continue-on-error: true`,
  `if: ${{ !cancelled() }}`, `uv run --locked --extra test --group lint lint-imports --config .importlinter`
  (`.github/workflows/ci.yml:159-164`). The lab tests run before it (`ci.yml:151-152`).
- First CI run of that config: `Contracts: 1 kept, 2 broken` (`layers`, `no-routes`) through `artifacts`,
  `reports`, `study_jobs`, `analysis_jobs`, `telemetry -> main` and `platform_models -> artifacts`
  (`openspec/changes/m03-gate-tooling/design.md:131-136`). The legacy config cannot become blocking before M9.2.
- Lab tests that pin the M0.3 set-up (`lab/tests/test_ci_gate_tooling.py`):
  - `_step(job, text)` asserts exactly one step whose run contains `text` (`:72-75`);
  - `test_importlinter_contract_mirrors_layers` asserts `.importlinter` holds exactly the three contracts
    (`:322-323`);
  - `test_import_linter_step_is_report_only` selects the step by the text `lint-imports` (`:351`), asserts it is the
    last step of `lab` (`:357`) and that no other step has `continue-on-error` (`:358`);
  - `_step(lab, "lint-imports")` is also used at `:267-268` and `:547`;
  - `_fails_job(job, step, allow_if=...)` checks that a step fails its job (`:78-84`).
- `.import_linter_cache` is not ignored by any `.gitignore` (no match); `lint-imports --no-cache` disables the cache
  (lookup, source: import-linter usage docs and `cli.py`).

Existing architecture tests (`openbinding-gateway/tests/test_architecture_layers.py`)
- `ALLOWED_LEGACY` (`:21-28`) and `COMPOSITION_ROOT = {"main"}` (`:29`); `routes_imports` (`:49-72`) and
  `gateway_imports` (`:118-137`) resolve relative and absolute imports by AST; `test_no_new_module_imports_routes`
  scans every file of the package (`:411-428`); `MAX_LINES = 1400` for `routes/v1.py` (`:285`).
- `GATE_LIFECYCLE_LEGACY` (`:194-203`). These ratchets stay untouched by M9.1 (nothing moves).
- Other whole-package scans that will see the new files: `tests/test_bim_boundary.py:95,105`,
  `tests/test_remote_cancel.py:904`, `tests/test_no_commercial_duplication.py:10`, `tests/test_job_repository.py:131`.
  Docstring-only `__init__.py` files trip none of them.

Factory configuration
- G9 lists no import-linter entry (`.agentic/project.yaml:75-86`); `.agentic/**` is R11, owner only (`:137-139`).
- `.github/**` is R10, level high (`.agentic/project.yaml:134-136`).
- Lab static suite argv: `uv run --locked --extra test pytest ../lab/tests` from `openbinding-gateway`
  (`.agentic/project.yaml:49`); OpenAPI snapshot: `uv run --locked python tools/dump_openapi.py --check` (`:66`).
- Change size limit 300 lines excluding tests and generated files (`.agentic/project.yaml:14`).
- G6 trace paths do not include `lab/` (`.github/workflows/ci.yml:224`; listed as a known item in
  `openspec/changes/m03-gate-tooling/proposal.md:56-57`): `[utest->...]` tags in `lab/tests` are not traced.
- CI pins OpenSpec 1.14.3 (`ci.yml:183-184`); the worker has 1.15.0.

import-linter 2.15 behaviour (lookup, medium confidence; verified by S1 checks before relying on it)
- Layers wrapped in parentheses are optional; `containers` accepts wildcards (since 2.2); `exhaustive = true` fails
  on an unlisted child of the container; `|` separates independent siblings.
- `forbidden` and `independence` accept `*` and `**` wildcards; a wildcard that matches nothing most likely yields
  zero modules (read from `forbidden.py`, not documented); a missing non-wildcard source module is an error.
- External packages in `forbidden_modules` need `include_external_packages = True`, root packages only.
- Contract types: `forbidden`, `protected`, `layers`, `independence`, `acyclic_siblings`.
- Sources: https://import-linter.readthedocs.io/en/stable/contract_types/ , .../contract_types/layers/ ,
  .../release_notes/ , https://github.com/seddonym/import-linter/blob/master/src/importlinter/cli.py

## 2. Design summary

- A second config, `openbinding-gateway/importlinter-modules.ini`, holds the contracts for `app`, `shared` and
  `modules`. Reasons: the legacy `.importlinter` is broken today and pinned to exactly three contracts
  (`lab/tests/test_ci_gate_tooling.py:322-323`); a separate file lets the new contracts block while the legacy
  ones stay report-only. The file name does not contain `--config .importlinter`, so the legacy step can be
  selected by that exact text.
- A new blocking step in job `lab` runs it, after the API acceptance step and before the report-only step (which
  stays last): `uv run --locked --extra test --group lint lint-imports --no-cache --config importlinter-modules.ini`,
  `working-directory: openbinding-gateway`, `if: ${{ !cancelled() }}`, no `continue-on-error`.
- The cross-module rule "only through `application`" is generic per module pair, which import-linter cannot express
  without one stanza per module; a gateway pytest (AST, like `test_architecture_layers.py`) enforces it. It runs
  in the `test` job and in G5 `gateway-unit`, both blocking.
- Starting point for S1 (S1 verifies it with checks 2 and 3 and adjusts it):

```ini
[importlinter]
root_package = openbinding_gateway
include_external_packages = True

[importlinter:contract:kernel]
name = shared imports no module, no composition root and no legacy layer above core
type = forbidden
source_modules =
    openbinding_gateway.shared
forbidden_modules =
    openbinding_gateway.app
    openbinding_gateway.main
    openbinding_gateway.modules
    openbinding_gateway.routes
    openbinding_gateway.services
    openbinding_gateway.repositories
    openbinding_gateway.db
    openbinding_gateway.jobs

[importlinter:contract:composition-root]
name = only the composition root imports app
type = forbidden
source_modules =
    openbinding_gateway.modules
    openbinding_gateway.shared
forbidden_modules =
    openbinding_gateway.app

[importlinter:contract:no-legacy-http]
name = modules do not import the legacy routes or main
type = forbidden
source_modules =
    openbinding_gateway.modules
forbidden_modules =
    openbinding_gateway.routes
    openbinding_gateway.main
allow_indirect_imports = True

[importlinter:contract:module-layers]
name = modules import only modules below them (ARCHITECTURE 4.2)
type = layers
containers =
    openbinding_gateway.modules
exhaustive = True
layers =
    (administration)
    (publishing)
    (laboratory)
    (execution)
    (engines) | (repository)
    (language)
    (collaboration)
    (identity)
    (plans)

[importlinter:contract:module-inside]
name = inside a module: adapters -> application -> domain
type = layers
containers =
    openbinding_gateway.modules.*
layers =
    (adapters)
    (application)
    (domain)

[importlinter:contract:pure-domain]
name = domain imports no framework, client or adapter
type = forbidden
source_modules =
    openbinding_gateway.modules.*.domain
forbidden_modules =
    fastapi
    starlette
    sqlalchemy
    alembic
    httpx
    requests
    redis
    dramatiq
    bim_client
    openbinding_gateway.modules.*.adapters
    openbinding_gateway.db
    openbinding_gateway.routes
```

`allow_indirect_imports` on `no-legacy-http` only: `main` reaches every router and legacy code already reaches
`main` (`telemetry -> main`, design.md:135), so an indirect rule would break on debt outside the modules. The SPACE
client's import name is added to `pure-domain` once S1 reads it from `uv.lock`/the installed package.

## 3. Slices (one capability: the module skeleton and its enforcement)

| Slice | Role | Owned files | Depends on | Risk (score) | Turns |
|---|---|---|---|---|---|
| S0 spec | specifier | `openspec/changes/m91-modules-skeleton/**` | `openspec/**` released or carved out | low (0, docs only) | 40 |
| S1 skeleton + contracts | implementer | 3 `__init__.py`, `importlinter-modules.ini`, `lab/tests/test_module_contracts.py` | S0 | medium (1, raised: every M9.2 move relies on these contracts) | 50 |
| S2 blocking CI step | implementer | `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py` | S1 merged | high (R10 `.github/**`) | 30 |
| S3 cross-module rule | implementer | `openbinding-gateway/tests/test_architecture_modules.py` | S0; parallel with S1 | low (0, tests only) | 40 |
| S4 docs | doc-steward | `docs/ARCHITECTURE.md` (§4.2 enforcement bullet only), `docs/architecture/gateway-as-is.md` | S1, S2, S3 | low (0, docs only) | 20 |

Owned globs are disjoint between parallel slices (S1 and S3 are the only parallel pair). Sizes (non-test lines):
S1 about 100, S2 about 8, S3 0 (about 150 test lines), S4 about 40. All under 300.

Requirement ids (S0 writes them in a new capability `gateway-architecture`, EARS, `req~name~1`):
- `req~gateway-architecture-skeleton~1`: `app`, `shared`, `modules` exist as docstring-only packages; nothing moves;
  `docs/openapi.json` unchanged.
- `req~gateway-architecture-module-contracts~1`: `importlinter-modules.ini` declares the contracts of §2 and the
  module order of ARCHITECTURE §4.2.
- `req~gateway-architecture-module-contracts-blocking~1`: the `lab` job runs them and fails on a broken contract;
  the legacy step stays report-only and last.
- `req~gateway-architecture-application-only~1`: outside `modules/<m>/`, only `app` and `main` may import anything
  of `modules.<m>` other than `modules.<m>.application`.

### S0 spec (specifier)
- Writes `proposal.md`, `design.md` (§2 above, the decisions and risks), `tasks.md` (S1-S4 with these checks) and
  `specs/gateway-architecture/spec.md`.
- Read-only: this intake, `docs/ARCHITECTURE.md` §4, `constitution.md` Article 6, `openspec/changes/m03-gate-tooling/**`.
- Gates: G1, G2. Check: `["openspec", "validate", "m91-modules-skeleton", "--strict"]`.

### S1 skeleton and contracts (implementer)
- Owned: `openbinding-gateway/src/openbinding_gateway/{app,shared,modules}/__init__.py` (a docstring each, pointing
  to ARCHITECTURE §4.2; no code), `openbinding-gateway/importlinter-modules.ini`, `lab/tests/test_module_contracts.py`
  (static assertions on the ini: contract set, module order equal to ARCHITECTURE §4.2, `exhaustive`, the three
  packages exist and hold no statement other than the docstring; tags `[utest->req~gateway-architecture-skeleton~1]`,
  `[utest->req~gateway-architecture-module-contracts~1]`).
- Read-only: `openbinding-gateway/.importlinter`, `lab/tests/test_ci_gate_tooling.py`, `tests/test_architecture_layers.py`.
- Gates: G3, G5, G7, G9, G11 (medium panel). Checks (all from the worktree root):
  0. `["bash","-c","cd openbinding-gateway && uv sync --locked --extra test --group lint"]`
  1. red_before: `{"argv": ["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests/test_module_contracts.py"], "type": "red_before", "expect_exit": [1], "expect_pattern": "AssertionError", "overlay": ["lab/tests/test_module_contracts.py"]}`
  2. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test --group lint lint-imports --no-cache --config importlinter-modules.ini"]` (exit 0; proves the empty-wildcard and optional-layer behaviour on the real tree)
  3. teeth probe (a copy in `$TMPDIR` with one deliberate violation per contract must break all of them; adjust the count to the final contract set):
     `["bash","-c","set -euo pipefail; cd openbinding-gateway; t=\"$TMPDIR/probe\"; rm -rf \"$t\"; mkdir -p \"$t\"; cp -r src \"$t/\"; g=\"$t/src/openbinding_gateway\"; p=\"$g/modules/plans\"; e=\"$g/modules/execution\"; mkdir -p \"$p/domain\" \"$p/application\" \"$p/adapters\" \"$e/application\"; for d in \"$p\" \"$p/domain\" \"$p/application\" \"$p/adapters\" \"$e\" \"$e/application\"; do : > \"$d/__init__.py\"; done; printf 'import fastapi\\nfrom openbinding_gateway.modules.plans import adapters\\n' > \"$p/domain/rules.py\"; printf 'from openbinding_gateway.modules.execution import application\\nfrom openbinding_gateway import app\\nfrom openbinding_gateway.routes import v1\\n' > \"$p/application/use_cases.py\"; printf 'from openbinding_gateway import modules\\n' > \"$g/shared/probe.py\"; set +e; PYTHONPATH=\"$t/src\" uv run --locked --extra test --group lint lint-imports --no-cache --config importlinter-modules.ini > \"$t/out.txt\" 2>&1; rc=$?; set -e; cat \"$t/out.txt\"; echo \"exit $rc\"; test \"$rc\" -eq 1; grep -E 'Contracts: 0 kept, 6 broken' \"$t/out.txt\""]`
  4. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests"]`
  5. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider tests/test_architecture_layers.py tests/test_bim_boundary.py tests/test_openapi_contract.py"]`
  6. `["bash","-c","cd openbinding-gateway && uv run --locked python tools/dump_openapi.py --check"]`
  7. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test ruff check src tests"]`
  8. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider"]` (timeout 1800)
  9. informational, legacy config unchanged: `["bash","-c","cd openbinding-gateway && { uv run --locked --extra test --group lint lint-imports --no-cache --config .importlinter > \"$TMPDIR/legacy.txt\" 2>&1; echo \"exit $?\"; }; grep -E 'Contracts: [0-9]+ kept, [0-9]+ broken' \"$TMPDIR/legacy.txt\""]` (same counts as on the base commit)
- Fallback: if check 2 fails because a wildcard (`modules.*`) matches nothing, S1 keeps the contracts that hold on
  an empty `modules/` (`kernel`, `composition-root`, `no-legacy-http`, `module-layers`), reports `partial`, and
  `module-inside` and `pure-domain` move to S3's AST test. No placeholder module is created (step 1 moves nothing,
  and a placeholder would have to pass `exhaustive`).

### S2 blocking CI step (implementer)
- Owned: `.github/workflows/ci.yml` (job `lab` only: one new step), `lab/tests/test_ci_gate_tooling.py` (select the
  legacy step by `--config .importlinter` at `:267`, `:351`, `:547`; add `test_module_contracts_step_is_blocking`,
  tagged `[utest->req~gateway-architecture-module-contracts-blocking~1]`, using `_fails_job(job, step,
  allow_if=True)`, order after the API acceptance step and before the report-only step).
- The step: name "Check module import contracts", `if: ${{ !cancelled() }}`, `working-directory:
  openbinding-gateway`, `run: uv run --locked --extra test --group lint lint-imports --no-cache --config
  importlinter-modules.ini`.
- Gates: G3, G5, G9, G10, G11 (high panel). Checks:
  0. `["bash","-c","cd openbinding-gateway && uv sync --locked --extra test"]`
  1. red_before: `{"argv": ["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests/test_ci_gate_tooling.py -k test_module_contracts_step_is_blocking"], "type": "red_before", "expect_exit": [1], "expect_pattern": "expected one step running", "overlay": ["lab/tests/test_ci_gate_tooling.py"]}`
  2. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests"]`
  3. the PR's CI run: the new step passes and the report-only step still runs last (pr-steward, `ci_status`).

### S3 cross-module rule (implementer)
- Owned: `openbinding-gateway/tests/test_architecture_modules.py` (new). It may import the helpers of
  `tests/test_architecture_layers.py` (read-only) or copy the resolver. Tests: detector fixtures over synthetic
  sources (a module importing `modules.<other>.domain`, `.adapters`, `.application.<sub>` is flagged;
  `modules.<other>.application` is not; `app` and `main` are exempt), and the real-tree rule, which must pass with
  `modules/` absent or empty. Tag `[utest->req~gateway-architecture-application-only~1]`.
- Gates: G5, G6, G9, G11 (low panel). G3: not applicable as a red-before (the rule guards code that does not exist
  yet; the fixtures are its proof); the coordinator confirms.
- Checks:
  0. `["bash","-c","cd openbinding-gateway && uv sync --locked --extra test"]`
  1. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider tests/test_architecture_modules.py tests/test_architecture_layers.py"]`
  2. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test ruff check src tests"]`

### S4 docs (doc-steward)
- Owned: `docs/ARCHITECTURE.md` (§4.2 "Enforcement" bullet names `importlinter-modules.ini` and
  `tests/test_architecture_modules.py`; nothing else), `docs/architecture/gateway-as-is.md` ("Architecture tests"
  section at `:339`: the new packages and the two configs).
- Gates: G11 (low panel). Check: `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests"]` (links and docs tests of the lab suite, if any).

## 4. Owner decisions (CRPs)

- CRP-1 ADR-0017 status: it is Proposed (`docs/adr/0017-…:5`), and M9.1 turns its consequence (G9 import-linter)
  into a blocking gate. Options: (a) accept ADR-0017 now, recommended; (b) proceed under Proposed and accept it
  with the M9.2 plan; (c) hold M9.1. The plan assumes (a) or (b); `docs/adr/**` is R11.
- CRP-2 factory gate: add `{name: import-linter-modules, cwd: openbinding-gateway, argv: [uv, run, --locked, --extra,
  test, --group, lint, lint-imports, --no-cache, --config, importlinter-modules.ini], needs: [uv]}` to G9 in
  `.agentic/project.yaml` (R11). Options: (a) add it after S1 merges, recommended; (b) CI only.
- CRP-3 constitution Article 6 "Enforced:" line (`constitution.md:78-80`): name `importlinter-modules.ini` and
  `tests/test_architecture_modules.py` for 6.5 and narrow the GAP to the legacy layout. Options: (a) edit after S2
  and S3 merge, recommended; (b) keep the GAP text until M9.2.

## 5. Risks

- import-linter facts are medium confidence: S1 checks 2 and 3 prove them on 2.15 before merge; fallback in S1.
- Chain-based contracts and legacy debt: once a module exists and legacy routes import it, a module that imports a
  legacy service reaching `main` (`telemetry -> main`) forms a chain from a lower to a higher module and breaks
  `module-layers`. Guidance for M4.2 and M9.2: modules import `core` and `db` only, never legacy services; use
  `ignore_imports` per edge only with a reason in the ini.
- `uv run --group lint` syncs the lint group into the venv; the new step runs after the lab and API acceptance
  steps for that reason (as M0.3 did, design.md:141-144).
- G6 does not trace `lab/`, so the S1 and S2 requirements show as uncovered in the trace until `lab/tests` is added
  to the G6 paths (followup, CI file owned by S2 after merge).
- M4.2 (`plans` module, another lead) must start after S1 merges, or it lands outside the contracts.
