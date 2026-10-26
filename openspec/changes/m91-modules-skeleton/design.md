# Design: m91-modules-skeleton

Status: plan. Facts come from `docs/agent-work/m91-modules-skeleton/intake.md` §1 (read at head 99697d7e); external
import-linter facts there are medium confidence and are proved by the S1 checks before anything relies on them.

## 1. Context and constraints

- Target layout and rules: `docs/ARCHITECTURE.md` §4.1–§4.2 (`:119-161`); migration step 1 moves nothing (`:173`).
- No `app`, `shared` or `modules` package exists and nothing imports one (intake §1). `create_app` and
  `app = create_app()` live in `main.py` (`:315`, `:1482`); the image runs `uvicorn openbinding_gateway.main:app`
  (`openbinding-gateway/Dockerfile:118`), so a subpackage `openbinding_gateway.app` does not clash with the attribute
  `main.app`. Hatchling and the image copy the whole `src/`, so no packaging change is needed.
- The legacy `openbinding-gateway/.importlinter` (three contracts, report-only) is broken on legacy debt
  (`openspec/changes/m03-gate-tooling/design.md:131-136`) and pinned to exactly three contracts by
  `lab/tests/test_ci_gate_tooling.py:322-323`. It stays byte-identical.
- `import-linter==2.15` is in the `lint` dependency group only; `test_import_linter_is_locked_dev_only` forbids it in
  the `test` extra (`lab/tests/test_ci_gate_tooling.py:327-345`). Gateway pytest therefore cannot run `lint-imports`;
  the tests of this change read the ini statically, and `lint-imports` runs as registered S1 checks.
- Behaviour-preserving: no runtime code, no route, no schema; `docs/openapi.json` byte-identical.

## 2. The skeleton and `importlinter-modules.ini` (S1)

Each of `app/__init__.py`, `shared/__init__.py`, `modules/__init__.py` holds one docstring pointing to
`docs/ARCHITECTURE.md` §4.2 and stating the package's role (composition root, kernel, bounded contexts). No import,
no `__all__`, no code.

Starting point of the configuration (S1 proves it with checks 2 and 3 of tasks.md and may only tighten it):

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
name = modules and shared do not import the composition root
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

- `shared` is the bottom of ARCHITECTURE's module order; it is not a layer of `module-layers` (whose container is
  `modules`) but is kept below every module by `kernel`.
- Layers in parentheses are optional, so absent modules do not break `module-layers`; `exhaustive = True` makes a
  module that is not in the list (a typo, an eleventh context) a broken contract.
- `allow_indirect_imports = True` only on `no-legacy-http`: `main` reaches every router and legacy code already reaches
  `main` (`telemetry -> main`), so an indirect rule would break on debt outside the modules.
- External packages in `forbidden_modules` need `include_external_packages = True` and root package names. The SPACE
  client's import name joins `pure-domain` once S1 reads it from `uv.lock` or the installed package.
- Every `lint-imports` run uses `--no-cache`: `.import_linter_cache` is not ignored by Git.
- Other whole-package scans (`tests/test_bim_boundary.py`, `tests/test_remote_cancel.py`,
  `tests/test_no_commercial_duplication.py`, `tests/test_job_repository.py`, `tests/test_architecture_layers.py`) see
  the three new files; docstring-only files trip none of them.

`openbinding-gateway/tests/test_modules_skeleton.py` carries `[utest->req~gateway-architecture-skeleton~1]` and
`[utest->req~gateway-architecture-module-contracts~1]`. It reads the package directories with `ast` and the two ini
files with `configparser`, compares the `module-layers` list with the order of ARCHITECTURE §4.2 written in the test,
and asserts that nothing outside the new packages imports them. The scenarios "Contracts hold on the current tree" and
"A violation breaks a contract" are proved by S1 checks 2 and 3 (`lint-imports` itself). In addition,
`tests/test_modules_skeleton.py` runs `lint-imports` on the tree and on copies with planted violations (the teeth
test). That test is skipped where `lint-imports` is not installed: the CI `test` job syncs only `--extra test`
(§1), so it runs there only once the blocking CI step (§6, pending) runs it with the `lint` group.
The OpenAPI scenario is proved by `tools/dump_openapi.py --check` and the existing snapshot tests
(`tests/test_b3_openapi.py`, `tests/test_b4_openapi_problem.py`).

## 3. Cross-module rule (S3)

"Other modules only through their `application` public API" is a rule per pair of modules. import-linter would need one
`forbidden` stanza per module and errors on a missing non-wildcard source module, so it cannot express the rule on an
empty `modules/`. An AST test does, and blocks today in the `test` job and in G5 `gateway-unit`.

`openbinding-gateway/tests/test_modules_cross_import.py`, tagged `[utest->req~gateway-architecture-application-only~1]`:

- A detector `cross_module_violations(source, path)` returns `(line, imported module)` pairs. It resolves absolute and
  relative `import` and `from … import` statements at any nesting level, as `routes_imports` and `gateway_imports` of
  `tests/test_architecture_layers.py` do (it may import those helpers, read-only, or copy the resolver). For
  `from X import Y`, the imported module is `X.Y` when `X.Y` is a subpackage or submodule path under `modules`, else
  `X`.
- An import of `openbinding_gateway.modules.<m>` or anything under it is allowed when the importing file is inside
  `modules/<m>/`, is `main.py` or is under `app/`, or when the imported module is exactly
  `openbinding_gateway.modules.<m>.application`. Everything else is a violation. Imports of
  `openbinding_gateway.modules` itself (no `<m>`) are not cross-module imports.
- Fixture tests over synthetic sources prove the detector (the scenarios of the requirement), and one real-tree test
  scans every `.py` file of the package; it passes with `modules/` absent or holding only `__init__.py`.
- G3 red-before does not apply to the real-tree test (the rule guards code that does not exist yet); the fixtures are
  its proof. The coordinator confirms this for S3.

## 4. S1 fallback

import-linter 2.15 accepting `openbinding_gateway.modules.*` wildcards that match nothing, and optional layers with
`exhaustive = True` on an empty container, is read from the docs and `forbidden.py`, not proved. S1 check 2 runs
`lint-imports` on the real tree and decides:

- Check 2 exits 0 with `Contracts: 6 kept, 0 broken`: the design stands.
- Check 2 fails because a wildcard matches nothing (`module-inside`, `pure-domain`): S1 keeps `kernel`,
  `composition-root`, `no-legacy-http` and `module-layers`, reports `partial`, and the rules `adapters → application →
  domain` and "domain imports no framework, client or adapter" move to the S3 AST test. This change is then amended by
  a specifier task before S1 merges: requirement `module-contracts` lists four contracts and the two rules become
  requirements traced by `test_modules_cross_import.py`. The revision stays 1 while no tagged test has merged.
- Check 2 fails on `module-layers` itself (optional layers with `exhaustive`): S1 stops and reports; no new layout is
  improvised.
- No placeholder module is created to feed the wildcards: step 1 moves nothing, and a placeholder would have to pass
  `exhaustive`.

## 5. Decisions and options considered

| Decision | Options considered | Reason |
|---|---|---|
| Separate `importlinter-modules.ini` | add contracts to `.importlinter` | `.importlinter` is pinned to three contracts and broken on legacy debt; the new contracts must hold from day one. The file name avoids the text `--config .importlinter`, so a later CI step can tell the two runs apart |
| Cross-module rule as an AST test | one import-linter stanza per module; `independence` contract | per-module stanzas fail on missing modules; `independence` would forbid the allowed `application` imports |
| Tests in `openbinding-gateway/tests` | `lab/tests` (intake) | G6 traces `openbinding-gateway/tests` but not `lab/`; the gateway suite runs in the `test` job and G5 |
| Static ini test plus `lint-imports` checks | run `lint-imports` from pytest | import-linter is in the `lint` group only, by `test_import_linter_is_locked_dev_only` |
| `allow_indirect_imports` on `no-legacy-http` only | everywhere; nowhere | legacy chains reach `main`; other contracts stay strict |

## 6. Deferred follow-ups (not requirements of this change)

- Blocking CI step (intake slice S2): one step in job `lab` of `.github/workflows/ci.yml`, after the API acceptance
  step and before the report-only `.importlinter` step (which stays last), running `uv run --locked --extra test
  --group lint lint-imports --no-cache --config importlinter-modules.ini` from `openbinding-gateway` with
  `if: ${{ !cancelled() }}` and no `continue-on-error`; `lab/tests/test_ci_gate_tooling.py` then selects the legacy step
  by `--config .importlinter` (`:267`, `:351`, `:547`). `.github/**` is R10 (high). The coordinator raises it with
  the owner separately; it needs its own change or an amendment adding its requirement.
- CRP-1: accept ADR-0017 (Proposed, `docs/adr/0017-modular-monolith-and-feature-sliced-frontend.md:5`), whose
  consequence is import-linter in G9. Owner only (`docs/adr/**`, R11).
- CRP-2: G9 entry `import-linter-modules` in `.agentic/project.yaml` (`cwd: openbinding-gateway`, argv as above,
  `needs: [uv]`). Owner only (`.agentic/**`, R11).
- CRP-3: constitution Article 6 "Enforced:" line (`constitution.md:78-80`) naming `importlinter-modules.ini` and the
  two tests for 6.5, and narrowing the GAP to the legacy layout. Owner only.

- Follow-up for M4.2: when `main`/`app` first imports a module, `req~gateway-architecture-skeleton~1` ("no module
  outside the new packages imports them") stops holding; M4.2 MUST MODIFY that requirement (new revision) in its delta.
- Follow-up: `docs/architecture/gateway-as-is.md` is outside this change's scope and still lacks the new packages and
  configs; a later doc task updates it.

## 7. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| import-linter wildcard and optional-layer behaviour unproved | contracts error on an empty `modules/` | S1 checks 2 and 3; fallback §4 |
| No CI step until the follow-up of §6 | a later PR could break a contract unseen by CI | S1 checks and review; the AST test of S3 blocks in CI today; M4.2 runs `lint-imports` as a check of its own contract |
| Chains through legacy code | once legacy routes import a module and that module imports a legacy service reaching `main`, `module-layers` breaks | modules import `core` and `db` only, never legacy services; `ignore_imports` per edge only with a reason in the ini (guidance for M4.2, M9.2) |
| M4.2 starts before S1 merges | `plans` lands outside the contracts | coordinator orders M4.2 after S1 |
| OpenSpec 1.14.3 in CI vs 1.15.0 in the lab | a validation difference | G1 here; CI job `openspec` reports |

## Requirements

| Id | Intent | Evidence |
|---|---|---|
| `req~gateway-architecture-skeleton~1` | `app`, `shared`, `modules` exist docstring-only; nothing moves; OpenAPI unchanged | `openbinding-gateway/tests/test_modules_skeleton.py`; S1 check `dump_openapi.py --check` |
| `req~gateway-architecture-module-contracts~1` | `importlinter-modules.ini` declares the six contracts and the §4.2 module order; `.importlinter` unchanged | `openbinding-gateway/tests/test_modules_skeleton.py`; S1 checks 2 and 3 |
| `req~gateway-architecture-application-only~1` | outside a module, only `app` and `main` import more than its `application` | `openbinding-gateway/tests/test_modules_cross_import.py` |
