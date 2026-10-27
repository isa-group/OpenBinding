# Tasks: m23-trade-off-chart

Slice T1 of M2.3 (`docs/agent-work/m23-run-result/handoff.md`), one PR, parallel with H1, B1, Q1, O1, E1 and V1.
Turns: spec 30, tests 35, implementation 60. Risk medium (R9: a new chart and its accessibility). Size: at most about
300 non-test lines. Tests carry `[utest->req~frontend-rendering-trade-off-chart~1]`, code `[impl->…]` (design.md §5).

Owned files, exclusive while the slice runs (all under `frontend/src/components/rendering/`): `TradeOffChart.tsx`,
`TradeOffChart.css`, `TradeOffChart.test.tsx`, `tradeOffModel.ts`, `tradeOffModel.test.ts`; plus
`docs/agent-work/m23-trade-off-chart/**` (how-to-test guide) and this change folder.

Checks (handoff "Checks", frontend directory, frozen install first):
- G1: `["openspec","validate","m23-trade-off-chart","--strict"]`, then G2 (epic review). Reported NOT EXECUTED while
  the lab lacks the CLI; CI runs `openspec validate --strict --all`.
- FI: `["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile"]`.
- RED (G3): `pnpm install --frozen-lockfile; pnpm exec vitest run src/components/rendering/TradeOffChart.test.tsx
  src/components/rendering/tradeOffModel.test.ts`, type `red_before`, `expect_exit` `[1]`, `expect_pattern`
  `AssertionError|TestingLibraryElementError`, `reject_pattern` `Failed to resolve import|Cannot find module|Transform
  failed|SyntaxError`, overlay the two test files and the two stubs.
- V: `pnpm exec vitest run src/components/rendering/TradeOffChart.test.tsx src/components/rendering/tradeOffModel.test.ts src/test`.
- LINT: `pnpm exec eslint .`. TSC: `pnpm exec tsc -b`.

Order: spec (this change, G1 and G2) → tests first (T1.1–T1.3, G3) → implementation (T1.4–T1.7). No dependency on
another slice. J1 places the component after this slice merges.

## Spec
- [x] 0.1 proposal.md, design.md (prop contract §2, decisions §3, summary §4), this file and the `frontend-rendering`
  delta with ADDED `req~frontend-rendering-trade-off-chart~1`.
- [ ] 0.2 G1 `openspec validate m23-trade-off-chart --strict` through a registered check, then G2.

## T1. Tests first (with stubs)
- [ ] 1.1 `tradeOffModel.test.ts`: the scenarios on `tradeOffPointsOf` (canonical solution; solutions and components
  that give no value, the first component of a criterion wins, labels keep the input position),
  `tradeOffObjectivesOf` (common criteria in first-point order, `[]`) and `nonDominated` (fixture `POINTS`, loss not
  value, equal points kept, the `objectives` argument).
- [ ] 1.2 `TradeOffChart.test.tsx`: the region and its label, the table `Non-dominated solutions` (headers, rows, the
  note, no `<pre>`), the number format, the image named by the summary, the two selects (names, initial values, options
  in order, native `<select>`, no `tabindex="-1"`), changing an axis, the swap, the legend texts with `aria-hidden`
  marks outside the image, one solution (table and note, no image, no combobox), the empty container for fewer than
  two objectives or no point, and the CSS (no hex colour, `min-height: 24px` on the selects). `ResponsiveContainer` may
  be mocked as in `components/TraceChart/TraceChart.test.tsx:5`.
- [ ] 1.3 Stubs: `TradeOffChart.tsx` (final export and `TradeOffChartProps`, renders `null`) and `tradeOffModel.ts`
  (final types and exports of design.md §2, each function returning `[]`); an empty `TradeOffChart.css` if the test
  reads it. RED (G3) passes: the tests fail by assertion only.
- Acceptance: every scenario of the requirement has at least one test; RED is green.

## T1. Implementation
- [ ] 1.4 `tradeOffModel.ts`: `tradeOffPointsOf`, `tradeOffObjectivesOf` and `nonDominated` as design.md §3.
- [ ] 1.5 `TradeOffChart.tsx`: region, `DataTable` of the non-dominated points, note, the two selects with the swap
  rule, the `role="img"` wrapper with the summary of design.md §4, the Recharts `ScatterChart` (two `Scatter` series,
  `circle` and `cross`, design tokens, no animation), the text legend, the one-solution note, nothing for fewer than two
  objectives or no point. No import from `pages/` or `api/`.
- [ ] 1.6 `TradeOffChart.css`: design tokens only, `min-height: 24px` on the selects, the chart at full width and
  280 px high, the legend marks.
- [ ] 1.7 `docs/agent-work/m23-trade-off-chart/review/how-to-test.md`: how to see the component (unit tests, and the
  ui-qa screenshots at 1440×900 and 390×844 from a test harness or J1's page), with the summary text to expect.
- [ ] 1.8 FI, V, LINT and TSC pass; the hygiene test (`src/test`) still passes with no allow-list change.
- [ ] 1.9 Review sign-off (G11): reviewer, test-reviewer and ui-qa (1440×900 and 390×844).
- Acceptance: V, LINT and TSC pass; no `package.json`, lockfile, page or allow-list change.

## Archive (later)
- [ ] Archive after `m21-rendering-catalogue` (the capability's first change), with the other m23 changes, in one
  explicit archive task: `["openspec","archive","m23-trade-off-chart","--yes"]`, then
  `["openspec","validate","--all","--strict"]`.

## Follow-ups outside this change
- J1: render `TradeOffChart` in `RunResult` when `tradeOffObjectivesOf(points).length >= 2`, and document it in
  `docs/qa/RENDERING_CATALOGUE.md` with the other five components.
- Coordinator: decide whether dominance includes the soft-constraint `penalty` (design.md §7, open question 1).
- Later revision: readable criterion names and units on the axes from the compiled problem (design.md §6).
- M6.1 and M3.4 may reuse the component for the study results and the problem Runs tab.
