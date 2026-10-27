## ADDED Requirements

### Requirement: Engine-claimed versus gateway-evaluated values
THE `EvaluationDiff` component SHALL compare the values an engine claimed for a run with the values the gateway evaluated and show, as text only, one summary line that says they agree, that they differ in a counted number of values, or that the claimed values are not kept, followed by one table row for each value that differs, up to 100 rows.

`req~frontend-rendering-evaluation-diff~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/EvaluationDiff.test.tsx`; `frontend/src/components/rendering/evaluationDiffModel.test.ts`

The comparison rules (pairing, tolerance, value kinds, row order, number format, limits) are in design.md §3 and §4. Every
string in `claimed`, `notes` and `downgrades` is external input from the engine: the component never interprets it as
markup (design.md §5). Fixture `EVAL` (used below) is `{ termination: 'FEASIBLE', solutions: [{ features: { latency:
120, cost: 3.5 }, score: 0.42 }, { features: { latency: 90, cost: 5 }, score: 0.47 }] }`; `CLAIM` is a deep copy of
`EVAL` that each scenario changes as stated.

#### Scenario: No claim kept for the run
- **GIVEN** `<EvaluationDiff evaluated={EVAL} />`, then `<EvaluationDiff evaluated={EVAL} claimed={null} />`
- **WHEN** each is rendered
- **THEN** a region named `Claimed and evaluated values` shows the line `The values the engine claimed are not kept for this run. Gateway evaluation: FEASIBLE, 2 solutions.`
- **AND** there is no region named `Differences` and no table
- **AND** `evaluationDiffOf(EVAL)` returns `status` `no-claim` and no rows

#### Scenario: Claim agrees within the tolerance
- **GIVEN** `CLAIM` with solution 1 `latency` set to `120.0000000005`
- **WHEN** `<EvaluationDiff evaluated={EVAL} claimed={CLAIM} />` is rendered
- **THEN** the region shows the single line `The engine claim agrees with the gateway evaluation: FEASIBLE, 2 solutions.`
- **AND** there is no table
- **AND** `evaluationDiffOf(EVAL, CLAIM)` returns `status` `agrees` and no rows

#### Scenario: One feature differs
- **GIVEN** `CLAIM` with solution 1 `latency` set to `100`
- **WHEN** `<EvaluationDiff evaluated={EVAL} claimed={CLAIM} />` is rendered
- **THEN** the line reads `The engine claim differs from the gateway evaluation in 1 value.`
- **AND** a region named `Differences` holds a table whose column headers read `Solution`, `Value`, `Engine claimed`, `Gateway evaluated`
- **AND** its only body row reads `1`, `latency`, `100`, `120`

#### Scenario: Termination and score differ
- **GIVEN** `CLAIM` with `termination` `OPTIMAL` and solution 2 `score` `0.45`
- **WHEN** the component is rendered with `EVAL`
- **THEN** the line reads `The engine claim differs from the gateway evaluation in 2 values.`
- **AND** the body rows read, in order, `Run`, `Termination`, `OPTIMAL`, `FEASIBLE` and `2`, `Score`, `0.45`, `0.47`

#### Scenario: Missing, extra and non-numeric features
- **GIVEN** `CLAIM` whose solution 1 `features` are `{ latency: 'fast', availability: 0.99 }`
- **WHEN** the component is rendered with `EVAL`
- **THEN** the body rows read, in order, `1`, `latency`, `not a number`, `120`; `1`, `cost`, `not stated`, `3.5`; `1`, `availability`, `0.99`, `not evaluated`
- **AND** the line counts `3 values`

#### Scenario: Different numbers of solutions
- **GIVEN** `CLAIM` with a third solution `{ features: { latency: 80, cost: 9 }, score: 0.5 }` and solution 1 `latency` set to `100`
- **WHEN** the component is rendered with `EVAL`
- **THEN** the only body row reads `Run`, `Solutions`, `3`, `2`
- **AND** the text `Solutions are compared one by one only when both sides have the same number of solutions.` is shown
- **AND** no row names solution `1`

#### Scenario: Score lists
- **GIVEN** `EVAL` whose solution 1 `score` is `[0.4, 0.6]`, and `CLAIM` whose solution 1 `score` is `[0.4, 0.5]`, then `0.4`
- **WHEN** each is rendered
- **THEN** the first shows the only body row `1`, `Score, component 2`, `0.5`, `0.6`
- **AND** the second shows the only body row `1`, `Score`, `0.4`, `0.4, 0.6`

#### Scenario: Number format and close values
- **GIVEN** `CLAIM` with solution 1 `latency` `1234.5`, then `120.000000002`
- **WHEN** each is rendered with `EVAL`
- **THEN** the first row reads `1`, `latency`, `1,234.5`, `120`
- **AND** the second row reads `1`, `latency`, `120.000000002`, `120`, because both values read `120` at six decimals

#### Scenario: Canonical fallbacks
- **GIVEN** `evaluated` `{ termination: 'FEASIBLE', solutions: [{ metrics: { latency: 120 }, objectives: { score: 0.42 } }] }` and `claimed` `{ termination: 'FEASIBLE', solutions: [{ features: { latency: 120 }, score: 0.42 }] }`
- **WHEN** the component is rendered
- **THEN** the line reads `The engine claim agrees with the gateway evaluation: FEASIBLE, 1 solution.`

#### Scenario: Malformed claim
- **GIVEN** `claimed` `{ termination: 7, solutions: 'many' }`, passed with a type cast
- **WHEN** the component is rendered with `EVAL`
- **THEN** it does not throw, and the body rows read `Run`, `Termination`, `no termination`, `FEASIBLE` and `Run`, `Solutions`, `0`, `2`

#### Scenario: Property names of the object prototype
- **GIVEN** `CLAIM` whose solution 1 `features` are `JSON.parse('{"latency":120,"cost":3.5,"constructor":1,"__proto__":2}')`
- **WHEN** the component is rendered with `EVAL`
- **THEN** the body rows read `1`, `constructor`, `1`, `not evaluated` and `1`, `__proto__`, `2`, `not evaluated`, in that order

#### Scenario: Engine text is shown as text
- **GIVEN** `CLAIM` with `termination` `<img src=x onerror=alert(1)>`, and `notes` `['<b>bold</b> **x** https://example.org']`
- **WHEN** the component is rendered with `EVAL`
- **THEN** the region holds no `img`, `b` or `a` element
- **AND** the texts `<img src=x onerror=alert(1)>` and `<b>bold</b> **x** https://example.org` are shown as written
- **AND** each of them is the text of a `bdi` element

#### Scenario: Direction controls stay inside the engine text
- **GIVEN** `RLO` = `String.fromCodePoint(0x202e)` (RIGHT-TO-LEFT OVERRIDE), `notes` `[RLO + 'evil']`, and `CLAIM` with solution 1 `features` `{ latency: 120, cost: 3.5, [RLO + 'cost']: 1 }`
- **WHEN** the component is rendered with `EVAL`
- **THEN** the note `RLO + 'evil'` is the whole text of a `bdi` element
- **AND** the feature name `RLO + 'cost'` in its row is the whole text of a `bdi` element

#### Scenario: Long engine text is shortened
- **GIVEN** a note of 600 `x`, then a note of 499 `x` followed by `'\u{1F600}\u{1F600}'` (two emoji, each a surrogate pair)
- **WHEN** each is rendered with `EVAL`
- **THEN** the first note reads 500 `x` followed by `…`
- **AND** the second reads 499 `x`, one `\u{1F600}` and `…`, with no broken surrogate pair
- **AND** a note of exactly 500 characters is shown whole, without `…`

#### Scenario: Engine notes
- **GIVEN** `notes` `['Solved with presolve', '', '  ', 'Gap 0.1%']`, then `[]`, then no `notes`
- **WHEN** each is rendered with `EVAL` and no claim
- **THEN** the first shows a list named `Engine notes` with the items `Solved with presolve` and `Gap 0.1%`, in that order
- **AND** the second and the third show no list named `Engine notes`

#### Scenario: Downgrade reasons
- **GIVEN** `downgrades` `[{ code: 'termination-changed', message: 'The engine claimed OPTIMAL without proof.' }, { code: 'solution-dropped', message: 'Malformed decision.', solution: 2 }]`, then `[]`
- **WHEN** each is rendered with `EVAL` and `CLAIM`
- **THEN** the first shows a list named `Why the gateway changed the result` with two items in that order
- **AND** the first item shows `The engine claimed OPTIMAL without proof.` and `termination-changed` in a `<code>` element
- **AND** the second item shows `Solution 3`, `Malformed decision.` and `solution-dropped` in a `<code>` element
- **AND** the second rendering shows no list named `Why the gateway changed the result`

#### Scenario: Limits on rows and notes
- **GIVEN** `CLAIM` whose solution 1 adds 150 features `f001` to `f150`, each with the value `1`, that `EVAL` does not have, then `notes` of 25 strings `n01` to `n25`
- **WHEN** each is rendered with `EVAL`
- **THEN** the first line reads `The engine claim differs from the gateway evaluation in 150 values.`, the table has 100 body rows, the last naming `f100`, and the text `50 more differences are not shown.` follows it
- **AND** the list named `Engine notes` has 20 items, the last `n20`, followed by the text `5 more notes are not shown.`

#### Scenario: Custom label and no raw rendering
- **GIVEN** `<EvaluationDiff evaluated={EVAL} claimed={CLAIM} label="Engine check" />`
- **WHEN** it is rendered
- **THEN** there is a region named `Engine check`
- **AND** the component renders no `<pre>` element

#### Scenario: The derivation is pure
- **GIVEN** `EVAL` and a `CLAIM` with solution 1 `latency` `100`, both deeply frozen
- **WHEN** `evaluationDiffOf(EVAL, CLAIM)` is called twice
- **THEN** it does not throw and both results are deeply equal

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/EvaluationDiff.css`
- **WHEN** it is read
- **THEN** it contains no hex colour
