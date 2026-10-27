# Change: m23-trade-off-chart

## Why

ROADMAP M2.3: "Run result rendered (`BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`,
`LogPanel`, and `TradeOffChart` when there are several objectives)", accepted when "offenders 1–4 removed from the
allow-list". ARCHITECTURE §5.3 defines `TradeOffChart` as "the trade-off set: non-dominated bindings as a table and a
two-axis chart whose axes are chosen among the objectives", used in the run result and the study results. INTENT §6
(Jobs row) asks for "with several objectives, the trade-off set as a table and a two-axis chart", and the retired
decision-space workspace hands "its useful part, the trade-off set of a multi-objective run" to the run and study pages
(ADR-0020 decision 3). Constitution 11 requires WCAG 2.2 AA, keyboard-operable named controls and a 24 px target.

This change is slice T1 of `docs/agent-work/m23-run-result/handoff.md` (owner request
own-58fe9d3b57f44525a17f2ff5bde0667f, release R1). It builds the component only; J1 and W1 place it on the run pages.

## What Changes

- A new catalogue component `TradeOffChart` under `frontend/src/components/rendering/`, with the prop contract of the
  handoff (`points`, `objectives`, `label = 'Trade-off set'`), pinned in design.md §2 because J1 relies on it.
- It shows the non-dominated solutions in a table of objective values. Dominance is computed on the canonical `loss`
  of each objective component (lower is better, direction already applied), never on the displayed `value`.
- With at least two solutions it adds a scatter chart (Recharts, already a dependency) with two selects, `Horizontal
  axis` and `Vertical axis`, over the objectives. The chart is an image with a text summary that names the axes and
  lists the non-dominated solutions. Non-dominated and dominated points differ by mark shape and a text legend, not
  by colour alone.
- With one solution only the table is shown, with a note that a chart needs two. With fewer than two objectives, or
  no solution, the component renders nothing.
- A pure model `tradeOffModel.ts`: `tradeOffPointsOf(solutions)` reads the canonical `objectives.components`,
  `tradeOffObjectivesOf(points)` lists the criteria every point carries, and `nonDominated(points, objectives?)`.
- No screen changes: no page imports the component in this change.

## Impact

- Capability: `frontend-rendering`. One ADDED requirement, `req~frontend-rendering-trade-off-chart~1`. The capability
  exists only in the unarchived `m21-rendering-catalogue` change, so this change adds and never modifies (intake R-f);
  archive m21 first.
- Repository: new files only, `frontend/src/components/rendering/TradeOffChart.{tsx,css,test.tsx}`,
  `frontend/src/components/rendering/tradeOffModel.ts` and `tradeOffModel.test.ts`, plus the how-to-test guide under
  `docs/agent-work/m23-trade-off-chart/`. No `package.json` or lockfile change (Recharts `^2.15.4` is already in
  `frontend/package.json`), no existing screen, no hygiene allow-list change.
- No HTTP API, OpenAPI or database schema change. No gateway, engine or bim-core change.
- Risk: medium (R9, a new chart and its accessibility). jsdom gives Recharts no size, so the unit tests cover the
  table, the selects, the summary and the model; ui-qa (1440×900 and 390×844) and J1's e2e screenshot cover the
  drawing (design.md §6).
- Dominance ignores the soft-constraint `penalty`, which a Pareto run appends to its `score` list (design.md §3, open
  question 1).
- G1: `openspec validate m23-trade-off-chart --strict`. This task has no registered check, so G1 is NOT EXECUTED
  here. The layout copies `m21-rendering-catalogue` and `m24-retire-sponsorship`.

## Out of scope

- Placing the component on the job and workbench run pages (J1, W1), and its entry in `docs/qa/RENDERING_CATALOGUE.md`
  (J1 documents all six components).
- The study results trade-off set (M6.1) and the problem Runs tab (M3.4), which may reuse the component later.
- Units and directions on the axes: a point carries no unit or direction (design.md §2); BindingTable and
  ObjectiveBreakdown show them.
- More than two axes, hypervolume, hulls, weights or any other analysis of the retired decision-space workspace
  (INTENT §6, ADR-0020).
- Editing `openspec/specs/**`, earlier changes, ARCHITECTURE or INTENT; archiving.
