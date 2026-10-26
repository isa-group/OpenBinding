# Handoff: m91-modules-skeleton
- Status: in-progress (planned, nothing built) · Updated: 2026-10-26T00:00:00Z
- Branch / head: task/ef86622c707040cc on base 99697d7e · PR: none

## Goal
ROADMAP M9.1 (`ROADMAP.md:184`): create `app/`, `shared/` and `modules/` in the gateway with import-linter
contracts that block for new modules only, moving no code and leaving `docs/openapi.json` byte-identical
(owner request `own-033e9b12c03448b28e474e292072c32c`, 2026-10-24; `docs/ARCHITECTURE.md:173`).

## State (with evidence)
- Intake written with verified facts and five slices: `docs/agent-work/m91-modules-skeleton/intake.md`.
- No OpenSpec change exists yet: `openspec/**` is held by other leads (task brief), so S0 waits.
- No `app`, `shared` or `modules` package exists; nothing imports one (repository grep, intake §1).
- Legacy `.importlinter` (3 contracts, report-only, broken on legacy debt: m03 design.md:131-136) stays unchanged.

## Decisions
- Separate config `openbinding-gateway/importlinter-modules.ini` — reason: `.importlinter` is pinned to exactly
  three contracts (`lab/tests/test_ci_gate_tooling.py:322-323`) and is broken today, so it cannot block.
- Blocking from the first slice — reason: ROADMAP M9.1 asks for "contracts enforced for new modules"; on an empty
  `modules/` nothing legacy can break them.
- New CI step in job `lab`, after the API acceptance step, before the report-only step, which stays last — reason:
  `lab/tests/test_ci_gate_tooling.py:357-358` and the sync-after-tests rule of m03 design.md:141-144.
- The legacy step is selected by `--config .importlinter` in the lab tests — reason: `_step` requires one match
  (`:72-75`) and the new step also runs `lint-imports`; the new file name avoids that substring.
- The cross-module "application only" rule is an AST pytest (`tests/test_architecture_modules.py`) — reason:
  import-linter would need one stanza per module and errors on missing source modules; the pytest blocks in the
  `test` job and G5 and works with zero modules.
- `--no-cache` on every `lint-imports` run — reason: `.import_linter_cache` is not ignored by Git (no match in any
  `.gitignore`) and checks must not leave files in the worktree.
- `allow_indirect_imports = True` only on the contract forbidding `routes`/`main` — reason: legacy code reaches
  `main` (`telemetry -> main`), which would break an indirect rule on debt outside the modules.

## Ruled out
- Adding the module contracts to `.importlinter` — breaks `test_importlinter_contract_mirrors_layers` and would stay
  report-only with the legacy debt.
- Running import-linter from the gateway pytest suite — import-linter is in the `lint` group only, and
  `test_import_linter_is_locked_dev_only` forbids it in the `test` extra (`lab/tests/test_ci_gate_tooling.py:327-345`).
- A placeholder module to feed the wildcard contracts — step 1 moves nothing, and it would have to pass `exhaustive`.
- Calling import-linter without the text `lint-imports` to dodge `_step` — hides the step from review; the test is
  amended instead (S2).

## Open questions and risks
- CRP-1: accept ADR-0017 (Proposed, `docs/adr/0017-…:5`) — waiting on owner; plan proceeds under (a) or (b).
- CRP-2: add `import-linter-modules` to G9 in `.agentic/project.yaml` (R11) — waiting on owner.
- CRP-3: update the constitution Article 6 "Enforced:" line (`constitution.md:78-80`) — waiting on owner, after S2/S3.
- `openspec/**` held by other leads — waiting on coordinator: release it or carve out
  `openspec/changes/m91-modules-skeleton/**` for S0.
- import-linter 2.15 behaviour on empty wildcards and optional layers with `exhaustive` is medium confidence
  (lookup) — mitigation: S1 checks 2 and 3, fallback in intake §3 S1.
- Chains through legacy code (`telemetry -> main`) can break `module-layers` once modules exist — mitigation:
  modules import `core`/`db` only; noted for M4.2 and M9.2.
- G6 does not trace `lab/` — S1/S2 requirements uncovered in the trace until the G6 paths include `lab/tests`.
- M4.2 (`plans` module, other lead) must start after S1 merges — coordinator to order.

## Next three steps
1. Coordinator: assign S0 (specifier) once `openspec/changes/m91-modules-skeleton/**` is writable; contract text in
   intake §3 S0; check `["openspec", "validate", "m91-modules-skeleton", "--strict"]`.
2. After S0 passes G1/G2: run S1 and S3 in parallel (disjoint files) with the owned globs and check arrays of
   intake §3; S1 check 2 decides whether the fallback applies.
3. After S1 merges: S2 (high panel, R10), then S4; raise CRP-1 now and CRP-2/CRP-3 after S2 and S3 merge.

## Evidence
- Tasks: ef86622c707040cc (this planner intake, no checks registered) · Base: 99697d7e · CI: none yet.
- Lookups: import-linter contract types and wildcard/optional-layer behaviour; `--no-cache`/`--config` (sources in
  intake §1).
