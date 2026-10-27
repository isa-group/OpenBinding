## ADDED Requirements

### Requirement: Objective breakdown
THE `ObjectiveBreakdown` component SHALL show, in a region named by `label` (default `Objective breakdown`), the scalarization, score and penalty of one solution's objective evaluation as given, and one table row per objective term in the given order with its criterion, feature, direction, value with unit and loss, plus the weight and the weighted loss when the scalarization is `weighted-sum`, from the terms that `objectiveTermsOf` derives from the canonical objectives and, when given, the compiled problem.

`req~frontend-rendering-objective-breakdown~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/ObjectiveBreakdown.test.tsx`; `frontend/src/components/rendering/objectiveModel.test.ts`

The props and the model are pinned in design.md §2. The fixtures of the scenarios are in design.md §3: `OBJ_SINGLE`
(a `SINGLE` `weighted-sum` evaluation of the criteria `fast` on feature `latency` and `reliable` on feature
`availability`, penalty `2`, score `2.375`), `OBJ_LEX` (the same terms, scalarization `lexicographic`, weights `0`,
penalty `0`, score `[0.25, 0.5, 0]`) and `PROBLEM` (`fast` minimize, `reliable` maximize, units `ms` and `%`). The
score and the penalty are the gateway's; the component never recomputes them. The weighted loss of a term and the
`Total weighted loss` row, shown when the scalarization is `weighted-sum` and the score is not a list, are display aids
only (design.md §1).

#### Scenario: Terms derived with a problem
- **GIVEN** `OBJ_SINGLE` and `PROBLEM`
- **WHEN** `objectiveTermsOf(OBJ_SINGLE, PROBLEM)` runs
- **THEN** it returns `scalarization` `weighted-sum`, `penalty` `2` and `score` `2.375`
- **AND** its `terms` are exactly `{ criterion: 'fast', feature: 'latency', direction: 'minimize', unit: 'ms', value: 350, loss: 0.25, weight: 0.5, weighted: 0.125 }` and `{ criterion: 'reliable', feature: 'availability', direction: 'maximize', unit: '%', value: 99.5, loss: 0.5, weight: 0.5, weighted: 0.25 }`, in that order

#### Scenario: Terms derived without a problem
- **GIVEN** `OBJ_SINGLE` and no compiled problem
- **WHEN** `objectiveTermsOf(OBJ_SINGLE, null)` runs
- **THEN** both terms have `direction` `null` and `unit` `null`
- **AND** their criterion, feature, value, loss, weight and weighted loss are those of the scenario with a problem

#### Scenario: A problem that does not name the criterion or the feature
- **GIVEN** `OBJ_SINGLE` and the problem `{ criteria: [{ id: 'other', direction: 'maximize' }], features: {} }`
- **WHEN** `objectiveTermsOf` runs
- **THEN** both terms have `direction` `null` and `unit` `null`

#### Scenario: Objectives that are not canonical
- **GIVEN** each of `null`, `undefined`, `'x'`, `[]` and the earlier shape `{ mode: 'single', score: 3 }` (no `components` list)
- **WHEN** `objectiveTermsOf(value, PROBLEM)` runs
- **THEN** it returns `null`

#### Scenario: Components read tolerantly
- **GIVEN** objectives whose `components` are `[{ feature: 'latency', value: 'fast', loss: 0.5 }, null]`, with `scalarization` `7`, `penalty` `'2'` and `score` `[0.25, 'x', 0]`
- **WHEN** `objectiveTermsOf(objectives, null)` runs
- **THEN** the first term is `{ criterion: 'criterion 1', feature: 'latency', direction: null, unit: null, value: null, loss: 0.5, weight: null, weighted: null }`
- **AND** the second term is `{ criterion: 'criterion 2', feature: null, direction: null, unit: null, value: null, loss: null, weight: null, weighted: null }`
- **AND** `scalarization` and `penalty` are `null`, and `score` is `[0.25, null, 0]`
- **AND** a `score` that is neither a finite number nor a list, such as `'bad'`, gives `null`

#### Scenario: Region and summary
- **GIVEN** `<ObjectiveBreakdown {...objectiveTermsOf(OBJ_SINGLE, PROBLEM)} />`, then the same with `label="Solution 1 objective"`
- **WHEN** each is rendered
- **THEN** there is a region named `Objective breakdown`, then one named `Solution 1 objective`
- **AND** the region holds a `<dl>` whose `<dt>` elements read `Scalarization`, `Score` and `Penalty` in that order, with the `<dd>` values `weighted-sum`, `2.375` and `2`

#### Scenario: Terms table of a weighted sum
- **GIVEN** `<ObjectiveBreakdown {...objectiveTermsOf(OBJ_SINGLE, PROBLEM)} />`
- **WHEN** it is rendered
- **THEN** a region named `Objective terms` holds a table whose column headers read exactly `Criterion`, `Feature`, `Direction`, `Value`, `Loss`, `Weight` and `Weighted loss`
- **AND** the first body row has the row header `fast` and the cells `latency`, `lower is better`, `350 ms`, `0.25`, `0.5` and `0.125`
- **AND** the second body row has the row header `reliable` and the cells `availability`, `higher is better`, `99.5 %`, `0.5`, `0.5` and `0.25`
- **AND** the table footer has one row with the row header `Total weighted loss` and the value `0.375`

#### Scenario: A list score
- **GIVEN** `<ObjectiveBreakdown {...objectiveTermsOf(OBJ_LEX, PROBLEM)} />`
- **WHEN** it is rendered
- **THEN** the `<dd>` of `Score` holds an ordered list named `Score` whose items read `fast: 0.25`, `reliable: 0.5` and `Penalty: 0`
- **AND** the table has no column header `Weight` or `Weighted loss` and no `Total weighted loss` row

#### Scenario: A list score of another length
- **GIVEN** the terms of `OBJ_LEX` with the score `[0.25]`, then with the score `[1, 2, 3, 4]`
- **WHEN** each is rendered
- **THEN** the list named `Score` reads `fast: 0.25`, then `fast: 1`, `reliable: 2`, `Penalty: 3` and `Entry 4: 4`
- **AND** an item of score position `i` takes the criterion of term `i`, the position right after the last term reads `Penalty`, and any later position reads `Entry <i+1>`

#### Scenario: A weighted sum with a list score
- **GIVEN** the terms of `OBJ_SINGLE` with scalarization `weighted-sum` and the score `[0.25, 0.5, 2]`
- **WHEN** it is rendered
- **THEN** the table has the column headers `Weight` and `Weighted loss`
- **AND** there is no `Total weighted loss` row

#### Scenario: Missing values
- **GIVEN** the term `{ criterion: 'criterion 1', feature: null, direction: null, unit: 'ms', value: null, loss: null, weight: null, weighted: null }` with scalarization `weighted-sum`, score `null` and penalty `null`, then the same with `scalarization` `null`
- **WHEN** each is rendered
- **THEN** each of the cells `Feature`, `Direction`, `Value`, `Loss`, `Weight` and `Weighted loss`, the total and the `<dd>` of `Score` and `Penalty` shows `—` in an `aria-hidden="true"` element and `no value` in an `.sr-only` element
- **AND** the `Value` cell does not contain `ms`
- **AND** with `scalarization` `null`, the `<dd>` of `Scalarization` shows the same dash and `no value`, and the table has no `Weight` column

#### Scenario: Total with a missing weighted loss
- **GIVEN** the terms of `OBJ_SINGLE` where the second term has `weighted` `null`, with scalarization `weighted-sum` and score `2.375`
- **WHEN** it is rendered
- **THEN** the `Total weighted loss` row shows `—` and `no value`, not `0.125`

#### Scenario: Number format
- **GIVEN** terms with the values `0`, `1234.5678` and `-99.5`
- **WHEN** they are rendered
- **THEN** their `Value` cells read exactly `0`, `1,234.568` and `-99.5` (numbers in en-US with at most three decimals, as in `MetricCards`)

#### Scenario: No terms
- **GIVEN** `<ObjectiveBreakdown terms={[]} scalarization="feasibility" score={0} penalty={0} />`
- **WHEN** it is rendered
- **THEN** the region shows `No objective terms` and holds no table
- **AND** its `<dl>` reads `Scalarization` `feasibility`, `Score` `0` and `Penalty` `0`

#### Scenario: Text only
- **GIVEN** the terms of `OBJ_SINGLE` with the criterion `<b>fast</b>` and the scalarization `<i>sum</i>`
- **WHEN** it is rendered
- **THEN** the texts `<b>fast</b>` and `<i>sum</i>` are shown as they are, and the region holds no `b`, `i` or `<pre>` element

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/ObjectiveBreakdown.css`
- **WHEN** it is read
- **THEN** it contains no hex colour
