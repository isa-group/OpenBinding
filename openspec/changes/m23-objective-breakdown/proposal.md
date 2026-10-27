# Change: m23-objective-breakdown

## Why

ROADMAP M2.3: "Run result rendered (`BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`,
`LogPanel`, and `TradeOffChart` when there are several objectives)", accepted when "offenders 1–4 removed from the
allow-list". ARCHITECTURE §5.2 puts "the objective breakdown" on the run page after the binding table and QoS against
bounds, and §5.3 defines `ObjectiveBreakdown` as the "weighted terms of the objective", used in the "run result, study
cell". ADR-0014 and constitution Article 15 require domain objects to be rendered by the catalogue, never dumped: today
the Jobs and Workbench screens list or dump the objectives (offenders 2 and 3, intake F7 and F8).

This is slice O1 of the M2.3 plan (`docs/agent-work/m23-run-result/handoff.md`): one new component, pure and with its
own derivation, that the page slices J1 (Jobs) and W1 (Workbench) compose through `RunResult`. The plan pins its prop
contract so that J1 can rely on it; design.md §2 fixes it.

## What Changes

- A new component `ObjectiveBreakdown` shows one solution's objective evaluation: the scalarization, the score and the
  penalty as the gateway evaluated them, and a table with one row per objective term (criterion, feature, direction
  in words, value with its unit, loss).
- For a `weighted-sum` scalarization the table adds each term's weight and weighted loss and, for a single score, a
  `Total weighted loss` row, so the reader sees how the score is built.
- A list score (several objectives, or a scalarization other than a single weighted sum) is shown as an ordered list
  that names each position by its criterion, then `Penalty`.
- A pure model `objectiveTermsOf(objectives, problem | null)` reads the canonical objective evaluation and takes
  directions and units from the compiled problem when the page has it. It returns `null` for objectives that are not
  canonical, such as the earlier `mode` shape, so nothing is guessed.
- Missing values show a dash read as `no value`. Every string renders as text. No screen changes in this change.

## Impact

- Capability `frontend-rendering`: one ADDED requirement, `req~frontend-rendering-objective-breakdown~1`. The
  capability lives in the unarchived change `m21-rendering-catalogue`, so this change adds and modifies nothing there
  (intake R-f); archive m21 first.
- Repository: new files only, `frontend/src/components/rendering/ObjectiveBreakdown.{tsx,css,test.tsx}`,
  `objectiveModel.ts` and `objectiveModel.test.ts` (handoff row O1), plus the slice's how-to-test guide under
  `docs/agent-work/m23-objective-breakdown/`. No existing screen, `package.json`, lockfile, `api/` file or allow-list
  entry changes; no new dependency.
- No HTTP API, OpenAPI or database change. No production impact until J1 wires the component.
- Risks (design.md §6): real runs may carry no canonical objectives in today's fixtures (intake R-a, checked in J1); the
  weighted loss is a client-side display aid, never a second score.
- G1: no `openspec validate` check is registered for this spec task, so it was not run (design.md §7).
- Size: about 200 non-test lines (component, model, stylesheet), under the 300-line limit.

## Out of scope

- Wiring the component into the Jobs and Workbench result screens, the `RunResult` composition, fixture moves to the
  canonical shape and allow-list changes (J1, W1, H1).
- The trade-off set across solutions (T1), QoS against bounds and the binding table (Q1, B1), and engine-claimed values
  (E1, C1).
- Study cells (ARCHITECTURE §5.3 lists them as a second use; studies are M2.5 and later).
- Recomputing or checking the score in the client; editing ARCHITECTURE, the catalogue page `docs/qa/RENDERING_CATALOGUE.md`
  (J1 documents all six components) or `openspec/specs/**`; archiving.
