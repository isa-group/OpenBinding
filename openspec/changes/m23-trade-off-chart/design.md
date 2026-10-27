# Design: m23-trade-off-chart

Status: slice T1 of M2.3 (`docs/agent-work/m23-run-result/handoff.md`), parallel with H1, B1, Q1, O1, E1 and V1.
Fixed inputs: ARCHITECTURE §5.3 (`TradeOffChart` row) and the Recharts rule after the table, the canonical solution
shape of bim-engine/v1 (intake F11), the handoff prop contract and its trade-off decision, constitution 11, and the
catalogue rules of `m21-rendering-catalogue` (design tokens only, Testing Library queries by role and name).

## 1. Context

A canonical solution carries `objectives = {type, scalarization, components, penalty, score}`, where each component is
`{criteria, feature, value, loss, weight}` (`bim-toolchain/packages/bim-core/src/bim_core/protocol.py:56-57`,
`:186-199`). The compiler computes `loss` from `value` with the criterion's direction already applied
(`bim_core/compiler.py:4333-4344`):

| Criterion | `loss` |
|---|---|
| minimize, no `normalize` | `value` |
| maximize, no `normalize` | `-value` |
| minimize, `normalize {min, max, clamp}` | `(value - min) / (max - min)`, clamped when `clamp` |
| maximize, `normalize` | `1 - (value - min) / (max - min)`, clamped when `clamp` |

So `loss` is lower-is-better for every criterion, and `value` is what a person recognises (a cost, a latency). The
gateway keeps these fields when it re-evaluates (`reevaluate.py:113-119`). A Pareto run returns several solutions; a
SINGLE weighted-sum run returns one, and its `score` is a number instead of a list (`compiler.py:4361-4366`).

The frontend has a hand-drawn trade-off plot for studies (`pages/Studies/AnalyticsCharts.tsx:82-107`): a `role="img"`
element whose `aria-label` names the measures and lists the best trade-offs. This component follows that accessible
pattern, but draws with Recharts as ARCHITECTURE §5.3 requires, like `components/TraceChart/TraceChart.tsx`.

## 2. Prop contract (J1 relies on it)

The types are structural and declared in `tradeOffModel.ts`; the component imports nothing from `pages/` and nothing
from `api/`.

```ts
/** One solution of the run, as plotted. */
export interface TradeOffPoint {
  id: string;                      // stable React key, `solution-<n>`
  label: string;                   // shown text, `Solution <n>`
  values: Record<string, number>;  // criterion id -> component `value` (shown on axes and in the table)
  losses: Record<string, number>;  // criterion id -> component `loss` (dominance only; lower is better)
}

export interface TradeOffChartProps {
  points: readonly TradeOffPoint[];
  objectives: readonly string[];   // criterion ids in display order; the component needs at least two
  label?: string;                  // name of the region, default 'Trade-off set'
}

/** Structural input of the model: the canonical solution, only the fields read here. */
export interface TradeOffSolution {
  objectives?: {
    components?: ReadonlyArray<{ criteria?: unknown; value?: unknown; loss?: unknown }> | null;
  } | null;
}

export function tradeOffPointsOf(solutions: readonly TradeOffSolution[]): TradeOffPoint[];
export function tradeOffObjectivesOf(points: readonly TradeOffPoint[]): string[];
export function nonDominated(points: readonly TradeOffPoint[], objectives?: readonly string[]): TradeOffPoint[];
```

`tradeOffObjectivesOf` and the optional second argument of `nonDominated` are additions to the handoff contract. They
keep the handoff's two functions as named and let J1 compute `objectives` without reading the solutions twice. J1
renders the component when `tradeOffObjectivesOf(points).length >= 2` (handoff `RunResult` order).

## 3. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Dominance | `a` dominates `b` when `a.losses[o] <= b.losses[o]` for every objective `o` and `<` for at least one. `nonDominated` keeps the points no other point dominates, in input order; points with equal losses on every objective are all kept | dominance on `value`: wrong for every maximized criterion (higher availability would count as worse); dominance with a direction per criterion: the point carries none, and `loss` already applies it |
| Objectives of dominance | all of `objectives` (default `tradeOffObjectivesOf(points)`), not only the two plotted axes. The table and the marks therefore do not change when an axis changes | dominance on the two plotted axes: the table would change with the selects, and a point could look dominated on screen while no other solution beats it on every objective. The summary and the legend say "not dominated", not "best on these axes" |
| Penalty | not part of dominance and not an axis. A Pareto run appends `penalty` to its `score` list (`compiler.py:4366`); soft violations are shown by `QoSAgainstBounds` and `ObjectiveBreakdown` | adding `penalty` as a hidden last objective: closer to the engine's `score`, but the handoff fixes dominance on `loss`, and a hidden dimension cannot be explained on the chart (open question 1) |
| Shown numbers | `value` on the axes, in the tooltip, in the table and in the summary, formatted en-US with at most three decimals, as `MetricCards` | `loss`: normalized or negated numbers a person does not recognise |
| Reading the solutions | `tradeOffPointsOf` reads `objectives.components` only. A component counts when `criteria` is a non-empty string and `value` and `loss` are finite numbers; the first component of a criterion wins; a solution with no counted component gives no point. Labels keep the solution's position in the input (`Solution 2` stays `Solution 2` when the first solution gives no point) | reading `score`: a list of losses without criterion names; reading `features ?? metrics`: features are not objectives. A legacy solution with `objectives.mode` and no `components` gives no point (intake F12; J1 moves the fixtures to the canonical shape) |
| Common objectives | `tradeOffObjectivesOf` returns the criteria present in both `values` and `losses` of every point, in the order of the first point; `[]` for no point | the union: points without a value for an axis cannot be placed or compared |
| Too little data | fewer than two `objectives`, or no point: the component renders nothing (J1 does not mount it then). One point: the region shows the table and the note `A chart needs at least two solutions; this run has one.`, with no selects and no chart (handoff decision) | an empty chart: a single dot conveys nothing and has no trade-off |
| Axis controls | two native `<select>` elements labelled `Horizontal axis` and `Vertical axis`, options in `objectives` order with the criterion id as text; initial values `objectives[0]` and `objectives[1]`. Choosing on one select the criterion the other shows swaps the two, so the axes never show the same criterion | disabling the other select's option: a disabled option is skipped silently by some screen readers; allowing the same criterion on both axes: a diagonal line that shows no trade-off |
| Chart accessibility | a wrapper `role="img"` whose `aria-label` is the summary of §4; Recharts' SVG inside it is presentation only. The summary changes with the axes | `aria-describedby` to a hidden paragraph: two nodes to keep in sync; Recharts' own `accessibilityLayer`: it announces raw coordinates per point, not the trade-off |
| Marks | non-dominated points are filled circles, dominated points are crosses (`Scatter` `shape="circle"` and `shape="cross"`), with a visible text legend `not dominated` and `dominated` whose marks are `aria-hidden="true"`; colours are design tokens (`var(--color-accent)`, `var(--color-text-secondary)`) | colour only: fails WCAG 1.4.1 (constitution 11.1) |
| Table | `DataTable` (`components/ui/DataTable.tsx`, a focusable scroll region) named `Non-dominated solutions`, `minWidth` 480: a `Solution` column, then one column per objective in `objectives` order, headers the criterion ids; under it the note `Not dominated: no other solution is at least as good on every objective and better on at least one.` | a list of cards: harder to compare values across solutions |
| Target size | the selects get `min-height: 24px` in `TradeOffChart.css` (constitution 11.2); the global phone rule of `globals.css` does not name `select` (`test/mobileTouchTargets.test.ts:22-24`) | relying on browser defaults |
| Drawing | `ResponsiveContainer` width 100 %, height 280 px, `ScatterChart` with `CartesianGrid`, numeric `XAxis` and `YAxis` labelled by the criterion ids, `Tooltip` with the solution label and both values, `isAnimationActive={false}` (reduced motion) | a hand-drawn plot like `AnalyticsCharts.tsx`: ARCHITECTURE §5.3 says charts use Recharts |

## 4. Summary text

```
<N> solutions plotted by <x> (horizontal) and <y> (vertical); <K> not dominated: <label> (<x value>, <y value>); …
```

`N` is `points.length`, `K` is the number of non-dominated points (at least 1 for a non-empty set), and the list
follows input order. The numbers use the format of §3 ("Shown numbers"). Example for the fixture `POINTS` of the delta
spec: `4 solutions plotted by cost (horizontal) and latency (vertical); 3 not dominated: Solution 1 (12, 440);
Solution 2 (15, 412); Solution 4 (20, 300)`.

## 5. Requirements and tests

| Requirement | Tests |
|---|---|
| `frontend-rendering-trade-off-chart` | `components/rendering/TradeOffChart.test.tsx` (rendering, selects, summary, legend, note, CSS), `components/rendering/tradeOffModel.test.ts` (reading, common objectives, dominance) |

Tests carry `[utest->req~frontend-rendering-trade-off-chart~1]`; `TradeOffChart.tsx` and `tradeOffModel.ts` carry
`[impl->req~frontend-rendering-trade-off-chart~1]`. The tests query by role and accessible name (`region`, `table`,
`combobox` named `Horizontal axis`, `img` named by the summary), never by class. They may mock
`ResponsiveContainer` as `TraceChart.test.tsx:5` does; `src/test/setup.ts:7-13` already stubs `ResizeObserver`.

Tests first (intake §2.4): the tests-first task writes both test files with a stub `TradeOffChart.tsx` (the final
exports and prop types, rendering `null`) and a stub `tradeOffModel.ts` (the final exports, returning `[]`). Both
are overlaid in the red_before check, so the tests fail by assertion and never by import.

## 6. Risks

- jsdom gives `ResponsiveContainer` no size, so no unit test sees the dots, the axes or the tooltip (intake R-d).
  ui-qa at 1440×900 and 390×844 and J1's e2e screenshot check the drawing, the shapes and the legend.
- On a phone (390 px) the chart keeps 280 px of height and the full width; the table scrolls inside its region.
- Many solutions: the table lists only the non-dominated ones, but the chart draws every point. Pareto runs return
  tens of solutions, not thousands; no limit is set. `nonDominated` is quadratic in the number of points.
- Criterion ids are shown as they are (`cost`, `latency`); a readable name needs the compiled problem, which J1
  holds and may pass as the ids' labels in a later revision.
- With `penalty` left out (§3), a solution with a soft violation can be listed as not dominated when the engine's own
  `score` list ranks it worse.

## 7. Open questions

1. Should dominance include the soft-constraint `penalty` as a last, hidden objective, like the engine's `score` list?
   The handoff decides on `loss` only; the coordinator may override, which would be a revision `~2`.

## 8. Rollback

The change adds files no screen imports. Reverting the PR removes them; no data, API or other screen is touched.
