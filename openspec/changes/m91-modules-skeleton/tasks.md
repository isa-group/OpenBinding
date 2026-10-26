# Tasks: m91-modules-skeleton

S1 and S3 run in parallel (disjoint files); S4 runs after both merge. Each slice writes its tests first, stays under
300 non-test diff lines and is one PR into `develop`. qa_run has no working directory, so every check is a `bash -c`
argv from the repository root. Read-only context for all: this change, `docs/ARCHITECTURE.md` §4,
`constitution.md` Article 6, `openbinding-gateway/tests/test_architecture_layers.py`.

The blocking CI step (intake slice S2) is not part of this change (design.md §6).

## S1. Skeleton and contracts (implementer; risk medium; ~100 non-test lines + ~120 test lines; turn budget 50)

- Owned: `openbinding-gateway/src/openbinding_gateway/app/__init__.py`,
  `openbinding-gateway/src/openbinding_gateway/shared/__init__.py`,
  `openbinding-gateway/src/openbinding_gateway/modules/__init__.py`, `openbinding-gateway/importlinter-modules.ini`,
  `openbinding-gateway/tests/test_modules_skeleton.py`.
- Read-only: `openbinding-gateway/.importlinter`, `lab/tests/test_ci_gate_tooling.py`, `docs/openapi.json`.
- Requirements: `req~gateway-architecture-skeleton~1`, `req~gateway-architecture-module-contracts~1` (design.md §2).
- [ ] 1.1 `tests/test_modules_skeleton.py`, tagged `[utest->req~gateway-architecture-skeleton~1]` and
  `[utest->req~gateway-architecture-module-contracts~1]`: packages exist and hold only a docstring; nothing outside
  them imports them; the ini's contract set, `root_package`, `include_external_packages`, the `module-layers` order and
  `exhaustive`; `.importlinter` still declares exactly `layers`, `no-routes`, `integrations`. Red on the base.
- [ ] 1.2 The three `__init__.py` files and `importlinter-modules.ini` as in design.md §2; the SPACE client's import
  name added to `pure-domain` after reading it from `uv.lock`.
- [ ] 1.3 If check 2 fails on an empty wildcard, apply the fallback of design.md §4 and report `partial`.
- Checks (from the root):
  0. `["bash","-c","cd openbinding-gateway && uv sync --locked --extra test --group lint"]`
  1. red_before: `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider tests/test_modules_skeleton.py"]`, expect exit 1 and `AssertionError`, overlay `openbinding-gateway/tests/test_modules_skeleton.py`.
  2. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test --group lint lint-imports --no-cache --config importlinter-modules.ini"]`: exit 0, `Contracts: 6 kept, 0 broken`.
  3. Teeth probe: a copy of `src` in `$TMPDIR` with one deliberate violation per contract (intake §3 S1 check 3) must
     report `Contracts: 0 kept, 6 broken` and exit 1 (count adjusted if the fallback applies).
  4. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider tests/test_modules_skeleton.py tests/test_architecture_layers.py tests/test_bim_boundary.py tests/test_b3_openapi.py tests/test_b4_openapi_problem.py"]`
  5. `["bash","-c","cd openbinding-gateway && uv run --locked python tools/dump_openapi.py --check"]`
  6. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test ruff check src tests"]`
  7. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests"]`
  8. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider"]` (timeout 1800)
  9. Informational, legacy unchanged: `lint-imports --no-cache --config .importlinter` gives the same
     `Contracts: N kept, M broken` as on the base commit.

## S3. Cross-module rule (implementer; risk low; 0 non-test lines + ~150 test lines; turn budget 40)

- Owned: `openbinding-gateway/tests/test_modules_cross_import.py` (new).
- Read-only: `openbinding-gateway/tests/test_architecture_layers.py` (its resolver may be imported or copied).
- Requirement: `req~gateway-architecture-application-only~1` (design.md §3).
- [ ] 3.1 Detector fixtures, tagged `[utest->req~gateway-architecture-application-only~1]`: another module's `domain`,
  `adapters`, `application.<sub>` and package root are flagged; `modules.<m>.application` is not; same-module imports
  (absolute and relative) and `main.py` and `app/` are exempt.
- [ ] 3.2 Real-tree test over every `.py` file of the package; passes with `modules/` absent or empty.
- [ ] 3.3 If S1 applied the fallback of design.md §4, the `module-inside` and `pure-domain` rules join this file
  after the spec amendment.
- G3: the real-tree test guards code that does not exist yet; the fixtures are its red proof (coordinator confirms).
- Checks:
  0. `["bash","-c","cd openbinding-gateway && uv sync --locked --extra test"]`
  1. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider tests/test_modules_cross_import.py tests/test_architecture_layers.py"]`
  2. `["bash","-c","cd openbinding-gateway && uv run --locked --extra test ruff check src tests"]`

## S4. Docs (doc-steward; risk low; ~40 lines; turn budget 20; after S1 and S3)

- Owned: `docs/ARCHITECTURE.md` (§4.2 "Enforcement" bullet only: name `openbinding-gateway/importlinter-modules.ini`,
  `tests/test_modules_skeleton.py` and `tests/test_modules_cross_import.py`), `docs/architecture/gateway-as-is.md`
  ("Architecture tests" section: the three packages and the two import-linter configurations, legacy report-only).
- [ ] 4.1 Both edits; no other section changes.
- Check: `["bash","-c","cd openbinding-gateway && uv run --locked --extra test pytest -q -p no:cacheprovider ../lab/tests"]`

## A. Archive (after S4, explicit archive task)

- [ ] `["openspec", "archive", "m91-modules-skeleton", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.
- [ ] Follow-ups outside this change (design.md §6): the blocking CI step; CRP-1 ADR-0017; CRP-2 G9 entry;
  CRP-3 constitution line; `gateway-architecture` in the capability table of `openspec/project.md`.

G1 for this change: `["openspec", "validate", "m91-modules-skeleton", "--strict"]`.
