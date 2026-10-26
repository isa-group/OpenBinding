# Change: m91-modules-skeleton

## Why

ROADMAP M9.1: "`app/`, `shared/`, `modules/` skeleton with import-linter contracts | contracts enforced for new
modules" (`ROADMAP.md:184`), requested by the owner on 2026-10-24 (`own-033e9b12c03448b28e474e292072c32c`).
`docs/ARCHITECTURE.md` §4.3 step 1: "Create `app/`, `shared/` and `modules/` with import-linter contracts; move
nothing" (`:173`). Step 2 lands new capabilities directly in modules, `plans` (M4.2) first, so the contracts must
exist before the first module does.

Constitution 6.5 requires new backend code in `modules/<context>/{domain,application,adapters}`, cross-module imports
only through `application` and a `domain` free of FastAPI, SQLAlchemy and HTTP clients (`constitution.md:67-69`); its
"GAP for 6.5–6.6: import-linter contracts for modules" (`:78-79`) is what this change starts to close.

## What Changes

- Three docstring-only packages in `openbinding-gateway/src/openbinding_gateway/`: `app/` (future composition root),
  `shared/` (kernel) and `modules/` (bounded contexts). No code moves; `docs/openapi.json` stays byte-identical.
- A second import-linter configuration, `openbinding-gateway/importlinter-modules.ini`, with six contracts for the
  new packages: the kernel imports no module, modules and shared do not import `app`, modules do not import the
  legacy `routes` or `main`, modules form the layers of ARCHITECTURE §4.2, and inside a module
  `adapters → application → domain` with a framework-free `domain` (design.md §2).
- A gateway AST test that fails when code outside a module, other than `main` and `app`, imports anything of that
  module except its `application` package.
- `docs/ARCHITECTURE.md` §4.2 "Enforcement" bullet names the new configuration and tests. Updating
  `docs/architecture/gateway-as-is.md` is a followup outside this change (design.md §6).

## Impact

- Capability: new `gateway-architecture`, 3 ADDED requirements. No HTTP API, OpenAPI, database, image or BIM
  contract change.
- Files: three `__init__.py`, `openbinding-gateway/importlinter-modules.ini`,
  `openbinding-gateway/tests/test_modules_skeleton.py`, `openbinding-gateway/tests/test_modules_cross_import.py`,
  `docs/ARCHITECTURE.md` (§4.2 enforcement bullet and §4.3 step 1).
- Unchanged on purpose: `openbinding-gateway/.importlinter` and its report-only CI step, `.github/**`,
  `tests/test_architecture_layers.py` and its ratchets (`ALLOWED_LEGACY`, `GATE_LIFECYCLE_LEGACY`, `MAX_LINES`).
- Risk: low to medium. Behaviour-preserving (no runtime code), but every later move of ROADMAP M9.2 and the first
  module of M4.2 rely on these contracts. import-linter 2.15 behaviour on wildcards that match nothing and optional
  layers with `exhaustive` is not yet proved on the real tree; S1 proves it and has a fallback (design.md §4).
- Order: S1 and S3 in parallel (disjoint files), then S4 (tasks.md). M4.2 (`plans`) starts after S1 merges.

## Out of scope

- The blocking CI step that runs `importlinter-modules.ini` in job `lab` (intake slice S2, `.github/workflows/ci.yml`
  and `lab/tests/test_ci_gate_tooling.py`, R10): raised separately with the owner (design.md §6). Until then the
  contracts are enforced by the S1 checks, the review gate and, after the owner's decision, CI.
- Owner-only items: accepting ADR-0017, the G9 entry in `.agentic/project.yaml`, the constitution Article 6
  "Enforced:" line (design.md §6).
- Moving any existing code into a module (ROADMAP M9.2), fixing the legacy debt reported by `.importlinter`
  (`telemetry -> main` and others), and the frontend boundaries (M9.3).
