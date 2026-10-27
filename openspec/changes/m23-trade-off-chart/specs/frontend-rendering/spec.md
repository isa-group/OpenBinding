## ADDED Requirements

### Requirement: Trade-off chart
WHERE at least two objectives and at least one point are given, THE `TradeOffChart` component SHALL show, in a region named by its `label` (default `Trade-off set`), the points that no other point dominates by `loss` in a table of their objective values and, for two points or more, a scatter chart named by a text summary whose axes two selects choose among the objectives.

`req~frontend-rendering-trade-off-chart~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/TradeOffChart.test.tsx`; `frontend/src/components/rendering/tradeOffModel.test.ts`

The prop contract, the dominance rule and the summary format are in design.md §2–§4. `loss` is lower-is-better with
the criterion's direction already applied; `value` is what the axes, the table and the summary show. The component is
built here and placed on the run pages by J1 and W1.

#### Scenario: Points read from canonical solutions
- **GIVEN** a solution whose `objectives.components` are `{ criteria: 'cost', feature: { id: 'cost' }, value: 12, loss: 12, weight: 0.5 }` and `{ criteria: 'availability', feature: { id: 'availability' }, value: 0.99, loss: -0.99, weight: 0.5 }`
- **WHEN** `tradeOffPointsOf([solution])` reads it
- **THEN** it returns exactly `[{ id: 'solution-1', label: 'Solution 1', values: { cost: 12, availability: 0.99 }, losses: { cost: 12, availability: -0.99 } }]`

#### Scenario: Solutions and components that give no value
- **GIVEN** the solutions, in order: one with no `objectives`; one with `objectives.components` `null`; one with `objectives: { mode: 'pareto' }` and no `components`; one whose components are `{ criteria: 'cost', value: 15, loss: 15 }`, `{ criteria: 'cost', value: 99, loss: 99 }`, `{ criteria: 'latency', value: Number.NaN, loss: 1 }`, `{ criteria: 'risk', value: 2, loss: '2' }` and `{ criteria: '', value: 1, loss: 1 }`
- **WHEN** `tradeOffPointsOf` reads them
- **THEN** it returns exactly `[{ id: 'solution-4', label: 'Solution 4', values: { cost: 15 }, losses: { cost: 15 } }]`
- **AND** a component counts only when `criteria` is a non-empty string and `value` and `loss` are finite numbers, the first component of a criterion wins, and labels keep the position of the solution in the input

#### Scenario: Objectives every point carries
- **GIVEN** the points `P1` with `values` and `losses` for `cost`, `latency` and `availability`, and `P2` with `values` and `losses` for `latency` and `cost`
- **WHEN** `tradeOffObjectivesOf([P1, P2])` and `tradeOffObjectivesOf([])` are computed
- **THEN** they return exactly `['cost', 'latency']` and `[]`

#### Scenario: Non-dominated points of the fixture
- **GIVEN** fixture `POINTS`, in order: `Solution 1` with values `{ cost: 12, latency: 440, availability: 0.99 }` and losses `{ cost: 12, latency: 440, availability: -0.99 }`; `Solution 2` with values `{ cost: 15, latency: 412, availability: 0.95 }` and losses `{ cost: 15, latency: 412, availability: -0.95 }`; `Solution 3` with values `{ cost: 18, latency: 450, availability: 0.97 }` and losses `{ cost: 18, latency: 450, availability: -0.97 }`; `Solution 4` with values `{ cost: 20, latency: 300, availability: 0.9 }` and losses `{ cost: 20, latency: 300, availability: -0.9 }`
- **WHEN** `nonDominated(POINTS)` is computed
- **THEN** it returns `Solution 1`, `Solution 2` and `Solution 4`, in that order
- **AND** `Solution 3` is left out because `Solution 1` has a loss lower or equal on every objective and lower on at least one

#### Scenario: Dominance uses the loss, not the value
- **GIVEN** `A` with values `{ cost: 10, availability: 0.99 }` and losses `{ cost: 10, availability: -0.99 }`, and `B` with values `{ cost: 10, availability: 0.9 }` and losses `{ cost: 10, availability: -0.9 }`
- **WHEN** `nonDominated([B, A])` is computed
- **THEN** it returns exactly `[A]`
- **AND** a comparison of the values, lower is better, would have kept `B`

#### Scenario: Equal points and the objectives argument
- **GIVEN** `C` and `D` with the same losses `{ cost: 5, latency: 100 }`, and `POINTS`
- **WHEN** `nonDominated([C, D])` and `nonDominated(POINTS, ['cost'])` are computed
- **THEN** the first returns `C` and `D`, and the second returns `Solution 1` only
- **AND** without the second argument dominance uses `tradeOffObjectivesOf(points)`, never only the two plotted axes

#### Scenario: Region and table of non-dominated solutions
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost', 'latency', 'availability']} />`
- **WHEN** it is rendered
- **THEN** there is a region named `Trade-off set` holding a region named `Non-dominated solutions`, which holds a table whose column headers read `Solution`, `cost`, `latency` and `availability`
- **AND** its body rows read `Solution 1`, `12`, `440`, `0.99`; `Solution 2`, `15`, `412`, `0.95`; `Solution 4`, `20`, `300`, `0.9`, and no row names `Solution 3`
- **AND** the text `Not dominated: no other solution is at least as good on every objective and better on at least one.` is shown, and there is no `<pre>`

#### Scenario: Region label
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost', 'latency']} label="Pareto set of run 14" />`
- **WHEN** it is rendered
- **THEN** there is a region named `Pareto set of run 14` and none named `Trade-off set`

#### Scenario: Number format
- **GIVEN** `P` with values and losses `{ cost: 1234.5678, latency: 1 }` and `Q` with values and losses `{ cost: 0, latency: 2 }`
- **WHEN** `<TradeOffChart points={[P, Q]} objectives={['cost', 'latency']} />` is rendered
- **THEN** their `cost` cells read exactly `1,234.568` and `0` (en-US, at most three decimals)

#### Scenario: Chart named by its summary
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost', 'latency', 'availability']} />`
- **WHEN** it is rendered
- **THEN** there is an element of role `img` named exactly `4 solutions plotted by cost (horizontal) and latency (vertical); 3 not dominated: Solution 1 (12, 440); Solution 2 (15, 412); Solution 4 (20, 300)`

#### Scenario: Axis selects
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost', 'latency', 'availability']} />`
- **WHEN** it is rendered
- **THEN** there is a combobox named `Horizontal axis` with the value `cost` and one named `Vertical axis` with the value `latency`
- **AND** each offers the options `cost`, `latency` and `availability`, in that order
- **AND** both are native `<select>` elements, and neither has `tabindex="-1"`

#### Scenario: Changing an axis
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost', 'latency', 'availability']} />`
- **WHEN** `availability` is selected in `Vertical axis`
- **THEN** the image is named `4 solutions plotted by cost (horizontal) and availability (vertical); 3 not dominated: Solution 1 (12, 0.99); Solution 2 (15, 0.95); Solution 4 (20, 0.9)`
- **AND** the table rows are unchanged

#### Scenario: Same criterion on both axes swaps them
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost', 'latency', 'availability']} />`
- **WHEN** `latency` is selected in `Horizontal axis`
- **THEN** `Horizontal axis` reads `latency` and `Vertical axis` reads `cost`
- **AND** the image is named `4 solutions plotted by latency (horizontal) and cost (vertical); 3 not dominated: Solution 1 (440, 12); Solution 2 (412, 15); Solution 4 (300, 20)`

#### Scenario: Marks never depend on colour alone
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost', 'latency']} />`
- **WHEN** it is rendered
- **THEN** a legend shows the visible texts `not dominated` and `dominated`, each after a mark with `aria-hidden="true"`, outside the element of role `img`
- **AND** non-dominated points are drawn as filled circles and dominated points as crosses (design.md §3); ui-qa checks the drawing, which jsdom does not lay out

#### Scenario: One solution
- **GIVEN** `<TradeOffChart points={[POINTS[0]]} objectives={['cost', 'latency']} />`
- **WHEN** it is rendered
- **THEN** the region `Trade-off set` holds the table with the one row `Solution 1`, `12`, `440`
- **AND** the text `A chart needs at least two solutions; this run has one.` is shown
- **AND** there is no element of role `img` and no combobox

#### Scenario: Fewer than two objectives or no point
- **GIVEN** `<TradeOffChart points={POINTS} objectives={['cost']} />`, `<TradeOffChart points={POINTS} objectives={[]} />` and `<TradeOffChart points={[]} objectives={['cost', 'latency']} />`
- **WHEN** each is rendered
- **THEN** its container is empty

#### Scenario: Tokens only and target size
- **GIVEN** `frontend/src/components/rendering/TradeOffChart.css`
- **WHEN** it is read
- **THEN** it contains no hex colour
- **AND** it gives the axis selects `min-height: 24px`
