# Change: m23-qos-against-bounds

## Why

ROADMAP M2.3: render the run result with the M2.1 catalogue plus `BindingTable`, `QoSAgainstBounds`,
`ObjectiveBreakdown`, `EvaluationDiff`, `LogPanel`, and `TradeOffChart` when there are several objectives, accepted when
offenders 1 to 4 leave the hygiene allow-list (owner request own-58fe9d3b57f44525a17f2ff5bde0667f, release R1).
ARCHITECTURE §5.3 lists `QoSAgainstBounds` as "aggregated QoS against constraint bounds" for the run result, and §5.2
places "QoS against bounds" on the run page after the binding table. INTENT principle 3: the gateway re-evaluates every
answer, so the gateway, not the browser, decides whether a rule holds.

This is slice Q1 of `docs/agent-work/m23-run-result/handoff.md`. The page slices J1 (jobs) and W1 (workbench) wire the
component; they rely on the prop contract pinned in design.md §2. No component of M2.3 exists yet (intake F3).

## What Changes

- A new rendering component `QoSAgainstBounds` under `frontend/src/components/rendering/`, with a pure derivation
  `qosBoundsOf` in `qosBoundsModel.ts`. Nothing in the application uses it until J1.
- A rule of the compiled problem whose assertion is a comparison of one quality with a number (`features.latency ≤ 600`,
  in either order, alone or joined by `and`) and that applies always shows as one bound row per comparison: the rule,
  the quality, must or should, the bound, the solution's value and the margin (`188 ms below`).
- Every other rule, and every violation the gateway reports for a rule the compiled problem does not hold, shows as a
  line of text with its condition (`applies when …`) when it has one.
- The status of every row is a word, `met`, `violated` or `not checked`, taken only from the gateway's `violations` of the
  solution; a violated soft rule also shows its penalty. The browser never decides a status by comparing a value with a
  bound.
- No screen changes in this change.

## Impact

- Capability `frontend-rendering`: one ADDED requirement, `req~frontend-rendering-qos-against-bounds~1`. The capability
  exists only in the unarchived change `m21-rendering-catalogue`; this change adds and never modifies (intake R-f), and
  is archived after m21.
- Code: new files only, `frontend/src/components/rendering/QoSAgainstBounds.{tsx,css,test.tsx}`, `qosBoundsModel.ts` and
  `qosBoundsModel.test.ts`. They reuse `components/ui` `Badge` and `DataTable` and import nothing from `pages/`.
- No HTTP API, OpenAPI, gateway, bim-core, `package.json` or lockfile change; no new dependency. No hygiene allow-list,
  `ROADMAP.md` or `docs/qa/RENDERING_CATALOGUE.md` change (J1 documents the wired component).
- Risks (design.md §6): rules that are not simple comparisons are shown as text without a position; a rule with a
  condition that did not hold reads `met`, because the gateway reports no violation for it; the formula notation is a
  second copy of the one in `pages/Cases/bindingModel.ts`.
- G1 (`openspec validate m23-qos-against-bounds --strict`) is not registered for the specifier task of this change; CI
  runs `openspec validate --strict --all`. The layout copies `m21-rendering-catalogue` and `m24-retire-sponsorship`.

## Out of scope

- Wiring the component into the jobs and workbench run results, loading the compiled problem, and choosing
  `features ?? metrics` (J1 and W1).
- Aggregating per-task values into a feature value, or evaluating expressions in the browser (INTENT principle 3).
- Positioning values for rules with a condition, comparisons of two qualities, arithmetic, `=`/`≠`, `or`, `not` or
  per-task paths: they are listed as text (intake R-b, R-c).
- Engine-claimed values and downgrade reasons (`EvaluationDiff`, CRP-M23-1).
- Moving the formula notation to a shared module (M9.3).
- Editing `openspec/specs/**`, `m21-rendering-catalogue` or other changes; archiving.
