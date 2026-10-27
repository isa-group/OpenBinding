# Change: m23-binding-table

## Why

ROADMAP M2.3: "Run result rendered (`BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`,
`LogPanel`, and `TradeOffChart` when there are several objectives)", accepted when "offenders 1–4 removed from the
allow-list" (owner request own-58fe9d3b57f44525a17f2ff5bde0667f, release R1). ARCHITECTURE §5.3 places "the binding
table" right after the verdict on the run page and lists `BindingTable` in the rendering catalogue as "task →
candidate → provider" for the run result. None of the new M2.3 components exists yet (intake F3).

This is slice B1 of the M2.3 plan (`docs/agent-work/m23-run-result/handoff.md`): one new catalogue component with its
pure derivation, built tests first and in parallel with the other component slices. The page slices J1 (Jobs) and W1
(Workbench) wire it in `RunResult` and rely on the prop contract pinned in design.md §2.

## What Changes

- A new catalogue component `BindingTable` in `frontend/src/components/rendering/`: one row per bound task, with the
  chosen candidate, its provider and the candidate's own feature values, one column per feature of the compiled
  problem with the unit in the header.
- A pure model `bindingTableModel.ts` with `bindingRowsOf(binding, problem)` and `bindingFeaturesOf(problem)`, which
  read the canonical `decision.binding` of a solution and the compiled problem as `readBindingProblem` returns it.
- Without the compiled problem, the table shows the columns Task and Candidate only, with the ids from the binding.
- Feature values are numbers or ranges, written the same way as on the case screens; a missing value reads `no value`.
- The table sits in the `DataTable` scroll region, so it scrolls sideways on narrow screens instead of squeezing.
- No page uses the component yet: J1 and W1 wire it.

## Impact

- Capability `frontend-rendering`: one ADDED requirement, `req~frontend-rendering-binding-table~1`. The capability
  exists only in the unarchived `m21-rendering-catalogue` change, so this change adds and never modifies (intake R-f).
- Code (all new, slice B1 owns them): `frontend/src/components/rendering/BindingTable.tsx`, `BindingTable.css`,
  `BindingTable.test.tsx`, `bindingTableModel.ts`, `bindingTableModel.test.ts`.
- Reused, unchanged: `components/ui/DataTable.tsx`, `utils/featureRange.ts` (`formatFeature`), the `.sr-only` class of
  `styles/globals.css`.
- No change to pages, routes, the hygiene allow-list, `RENDERING_CATALOGUE.md`, `ROADMAP.md`, the API client, the
  gateway, `docs/openapi.json` or `frontend/package.json`.
- Risks (design.md §6): the candidate is found by id among the task's eligible candidates, because the problem model
  does not keep the catalogue of each candidate; the table shows the candidate's own values, not contributions.
- G1: this specifier task has no registered check; `openspec validate m23-binding-table --strict` is reported NOT
  EXECUTED until a check runs it (intake F16).

## Out of scope

- Wiring the component into the Jobs and Workbench screens, fixtures, e2e and the allow-list (slices J1 and W1).
- Aggregated or per-feature contribution values of the whole binding: aggregation depends on the workflow and is the
  gateway's job (INTENT principle 3); the objective and QoS views are slices O1 and Q1.
- Selecting among several solutions: the caller passes one solution's binding.
- Sorting, filtering or editing the table.
- Editing `openspec/specs/**`, earlier changes, ARCHITECTURE or ROADMAP; archiving.
