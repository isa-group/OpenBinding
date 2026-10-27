## ADDED Requirements

### Requirement: QoS against bounds
THE `QoSAgainstBounds` component SHALL show, in a region named by `label`, each bound of the solution with its rule, quality, kind, bound, value, margin and status, and each other rule with its text, condition, kind and status, where the status of a rule reads `met`, `violated` or `not checked` as decided by the gateway's violations of that solution only.

`req~frontend-rendering-qos-against-bounds~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/qosBoundsModel.test.ts`; `frontend/src/components/rendering/QoSAgainstBounds.test.tsx`

The bounds and rules come from `qosBoundsOf(constraints, features, violations, units)` (design.md §2, §3); the browser
positions a value against a bound and never decides a status by comparing them (INTENT principle 3). In the scenarios,
`cmp(op, a, b)` stands for `{ kind: 'compare', op, left: a, right: b }`, `and(a, b)` for `{ kind: 'and', left: a,
right: b }`, `add(a, b)` for `{ kind: 'arithmetic', op: 'add', left: a, right: b }`, `features.x` for `{ kind: 'path',
segments: ['features', 'x'] }`, and a bare number or `true` for a literal. A reference `rules/x` is `{ resource:
'rules', id: 'x' }`.

Fixture `QOS`: constraints `max-latency` (ref `rules/max-latency`, hard, when `true`, assert
`cmp(lte, features.latency, 600)`), `cost-band` (ref `rules/cost-band`, soft, no when, assert
`and(cmp(lte, 2, features.cost), cmp(lt, features.cost, 10))`, penalty `5`), `busy-latency` (ref `rules/busy-latency`,
hard, when `cmp(gt, features.load, 5)`, assert `cmp(lte, features.latency, 400)`) and `bundle-cost` (ref
`rules/bundle-cost`, hard, when `true`, assert `cmp(lte, add(features.cost, features.fee), 12)`); features
`{ latency: 412, cost: 11.5, load: 3, fee: 0.25 }`; units `{ latency: 'ms', cost: 'EUR', load: null, fee: 'EUR' }`;
violations `[{ constraint: rules/cost-band, enforcement: 'soft', penalty: 2.5 }]`.

#### Scenario: Comparisons of one quality with a number become bounds
- **GIVEN** the fixture `QOS`
- **WHEN** `qosBoundsOf` reads it
- **THEN** `bounds` equals, in this order, `{ rule: 'max-latency', feature: 'latency', op: 'lte', limit: 600, value: 412, unit: 'ms', enforcement: 'hard', met: true }`, `{ rule: 'cost-band', feature: 'cost', op: 'gte', limit: 2, value: 11.5, unit: 'EUR', enforcement: 'soft', met: false, penalty: 2.5 }` and `{ rule: 'cost-band', feature: 'cost', op: 'lt', limit: 10, value: 11.5, unit: 'EUR', enforcement: 'soft', met: false, penalty: 2.5 }`
- **AND** the comparison `2 ≤ cost`, with the number on the left, reads `op: 'gte'`
- **AND** `max-latency` has no `penalty`

#### Scenario: Other rules become text
- **GIVEN** the fixture `QOS`
- **WHEN** `qosBoundsOf` reads it
- **THEN** `rules` equals, in this order, `{ rule: 'busy-latency', text: 'features.latency ≤ 400', when: 'features.load > 5', enforcement: 'hard', met: true }` and `{ rule: 'bundle-cost', text: '(features.cost + features.fee) ≤ 12', when: null, enforcement: 'hard', met: true }`

#### Scenario: Shapes that are not a bound
- **GIVEN** hard constraints with when `true` and the asserts `cmp(eq, features.latency, 600)`, `cmp(ne, features.latency, 600)`, `cmp(lte, features.latency, features.cost)`, `cmp(lte, 1, 2)`, `cmp(lte, { kind: 'path', segments: ['tasks', 'pay', 'latency'] }, 600)`, `cmp(lte, features.latency, { kind: 'negate', value: 5 })`, `cmp(eq, features.region, 'eu')`, `{ kind: 'or', left: cmp(lte, features.latency, 600), right: cmp(lte, features.cost, 10) }` and `{ kind: 'not', value: cmp(gt, features.latency, 600) }`, each with its own id, the features of `QOS` and the violations `[]`
- **WHEN** `qosBoundsOf` reads them
- **THEN** `bounds` is empty and `rules` holds nine entries, one per constraint in order
- **AND** their texts read `features.latency = 600`, `features.latency ≠ 600`, `features.latency ≤ features.cost`, `1 ≤ 2`, `tasks.pay.latency ≤ 600`, `features.latency ≤ −5`, `features.region = “eu”`, `(features.latency ≤ 600) or (features.cost ≤ 10)` and `not (features.latency > 600)`

#### Scenario: A mixed conjunction is never split
- **GIVEN** a hard constraint `mixed` with when `true` and assert `and(cmp(lte, features.latency, 600), cmp(eq, features.region, 'eu'))`, and a hard constraint `nested` with assert `and(and(cmp(gte, features.cost, 1), cmp(lte, features.cost, 9)), cmp(lt, features.latency, 700))`, both with when `true`, the features of `QOS` and the violations `[]`
- **WHEN** `qosBoundsOf` reads them
- **THEN** `mixed` yields no bound and one rule with text `(features.latency ≤ 600) and (features.region = “eu”)`
- **AND** `nested` yields three bounds with ops `gte`, `lte`, `lt` and limits `1`, `9`, `700`, in that order, and no rule

#### Scenario: A rule with a condition is text, even when it compares a quality with a number
- **GIVEN** the fixture `QOS`
- **WHEN** `qosBoundsOf` reads it
- **THEN** no bound has `rule: 'busy-latency'`
- **AND** the rule `busy-latency` has `when: 'features.load > 5'` and `met: true`, because the gateway reported no violation for it

#### Scenario: The status follows the gateway, not the value
- **GIVEN** the constraint `max-latency` of `QOS`, the features `{ latency: 700 }` and the violations `[]`, then the features `{ latency: 412 }` and the violations `[{ constraint: rules/max-latency, enforcement: 'hard', penalty: 0 }]`
- **WHEN** `qosBoundsOf` reads each and `QoSAgainstBounds` renders the result
- **THEN** the first bound has `met: true` and its row reads Value `700 ms`, Margin `100 ms above` and Status `met`
- **AND** the second bound has `met: false`, no `penalty`, and its row reads Value `412 ms`, Margin `188 ms below` and Status `violated` in a badge of class `badge-error`

#### Scenario: No violations list means not checked
- **GIVEN** the constraints, features and units of `QOS`, with the violations `undefined`, then `null`, then `{}`
- **WHEN** `qosBoundsOf` reads each and `QoSAgainstBounds` renders the result
- **THEN** every bound and rule has `met: null` and no `penalty`
- **AND** the region shows the paragraph `Not checked: this solution carries no violations list from the gateway.`
- **AND** each of the 3 bound rows and 2 rule items shows the status `not checked` in a badge of class `badge-default`
- **AND** with the violations `[]` the paragraph is absent

#### Scenario: A violation for a rule the compiled problem does not hold
- **GIVEN** the constraints `[]`, the features `{}` and the violations `[{ constraint: { resource: 'placement', id: 'edge-capacity' }, enforcement: 'hard', penalty: 0, message: 'Pool edge over capacity' }, { constraint: { resource: 'placement', id: 'core-capacity' }, enforcement: 'soft', penalty: 1.25 }, { constraint: { resource: 'placement', id: 'core-capacity' }, enforcement: 'soft', penalty: 0.75 }]`
- **WHEN** `qosBoundsOf` reads them
- **THEN** `bounds` is empty and `rules` equals `{ rule: 'edge-capacity', text: 'Pool edge over capacity', when: null, enforcement: 'hard', met: false }` and `{ rule: 'core-capacity', text: 'Reported by the gateway; not a rule of the compiled problem.', when: null, enforcement: 'soft', met: false, penalty: 2 }`
- **AND** with the constraints of `QOS` and these violations added to its own, the two rules come after `busy-latency` and `bundle-cost`

#### Scenario: Matching needs the resource and the id
- **GIVEN** the constraint `max-latency` of `QOS` and the violations `[{ constraint: { resource: 'other', id: 'max-latency' }, enforcement: 'hard', penalty: 0 }]`
- **WHEN** `qosBoundsOf` reads them
- **THEN** the bound `max-latency` has `met: true`
- **AND** `rules` holds one rule `max-latency` with the text `Reported by the gateway; not a rule of the compiled problem.` and `met: false`

#### Scenario: Unexpected input is left out
- **GIVEN** the constraints `'x'`, then `[null, 7, { enforcement: 'hard' }, { ref: { id: '' }, assert: cmp(lte, features.latency, 1) }]`, the features `null` and the violations `[null, { constraint: {} }, { enforcement: 'hard' }]`
- **WHEN** `qosBoundsOf` reads each
- **THEN** it throws nothing and returns `{ bounds: [], rules: [] }`

#### Scenario: Missing value
- **GIVEN** the constraint `max-latency` of `QOS`, the features `{ latency: 'fast' }`, then `{}`, then `undefined`, and the violations `[]`
- **WHEN** `qosBoundsOf` reads each and `QoSAgainstBounds` renders the result
- **THEN** the bound has `value: null`
- **AND** its Value and Margin cells each show `—` in an `aria-hidden="true"` element and `no value` in an `.sr-only` element, and contain no `ms`

#### Scenario: The bounds table
- **GIVEN** `qosBoundsOf` of `QOS`, rendered by `<QoSAgainstBounds bounds={bounds} rules={rules} />`
- **WHEN** it is rendered
- **THEN** there is a region named `QoS against bounds` holding a region named `Bounds` with a table whose column headers read `Rule`, `Quality`, `Kind`, `Bound`, `Value`, `Margin`, `Status`
- **AND** its body rows read, cell by cell, `max-latency` / `latency` / `must` / `≤ 600 ms` / `412 ms` / `188 ms below` / `met`, then `cost-band` / `cost` / `should` / `≥ 2 EUR` / `11.5 EUR` / `9.5 EUR above` / `violated` + `penalty 2.5`, then `cost-band` / `cost` / `should` / `< 10 EUR` / `11.5 EUR` / `1.5 EUR above` / `violated` + `penalty 2.5`
- **AND** a Status cell holds the status word in a badge and, when there is a penalty, the text `penalty <n>` after the badge, separated from it by a space
- **AND** each rule id is in a `<code>` element
- **AND** a bound whose value equals its limit reads Margin `at the limit`, and a bound with `unit: null` reads `≤ 600` and `412` with no trailing space

#### Scenario: The other rules list
- **GIVEN** `qosBoundsOf` of `QOS`, rendered by `QoSAgainstBounds`
- **WHEN** it is rendered
- **THEN** a list named `Other rules` holds two items, in order
- **AND** the first holds `busy-latency` in `<code>`, `features.latency ≤ 400`, `applies when features.load > 5`, `must` and the status `met`
- **AND** the second holds `bundle-cost` in `<code>`, `(features.cost + features.fee) ≤ 12`, `must` and the status `met`, and no text `applies when`

#### Scenario: Status words and badge variants
- **GIVEN** bounds with (`met: true`, hard), (`met: false`, hard), (`met: false`, soft, `penalty: 2.5`) and (`met: null`, soft)
- **WHEN** `QoSAgainstBounds` renders them
- **THEN** their statuses read `met` in `badge-success`, `violated` in `badge-error`, `violated` in `badge-warning` followed by `penalty 2.5`, and `not checked` in `badge-default`
- **AND** the status is always one of the words `met`, `violated`, `not checked`, never colour alone
- **AND** a rule of the `Other rules` list with `met: false`, soft and `penalty: 2` shows `violated` in `badge-warning` followed by `penalty 2`

#### Scenario: Only one of the two parts
- **GIVEN** `<QoSAgainstBounds bounds={[]} rules={rules} />` with one rule, and `<QoSAgainstBounds bounds={bounds} rules={[]} />` with one bound
- **WHEN** each is rendered
- **THEN** the first has no region named `Bounds` and no `table`
- **AND** the second has no list named `Other rules`

#### Scenario: Nothing to check
- **GIVEN** `<QoSAgainstBounds bounds={[]} rules={[]} />`
- **WHEN** it is rendered
- **THEN** the region named `QoS against bounds` holds only the text `No rules to check.`, with no table, no list and no `Not checked` paragraph

#### Scenario: Label
- **GIVEN** `<QoSAgainstBounds bounds={[]} rules={[]} label="Solution 2 against bounds" />`
- **WHEN** it is rendered
- **THEN** there is a region named `Solution 2 against bounds` and none named `QoS against bounds`

#### Scenario: Number format
- **GIVEN** a bound `{ rule: 'r', feature: 'cost', op: 'lte', limit: 1000, value: 1234.5678, unit: null, enforcement: 'soft', met: false, penalty: 0.1234 }`
- **WHEN** `QoSAgainstBounds` renders it
- **THEN** its Bound reads `≤ 1,000`, its Value `1,234.568`, its Margin `234.568 above`, and its status is followed by `penalty 0.123`

#### Scenario: Gateway and problem text render as text
- **GIVEN** a rule `{ rule: '<i>r</i>', text: '<b>Pool</b> edge full', when: null, enforcement: 'hard', met: false }`
- **WHEN** `QoSAgainstBounds` renders it
- **THEN** the item shows the literal texts `<i>r</i>` and `<b>Pool</b> edge full`
- **AND** the region contains no `b` or `i` element and no `<pre>`

#### Scenario: Tokens only, no page imports
- **GIVEN** `frontend/src/components/rendering/QoSAgainstBounds.css`, `QoSAgainstBounds.tsx` and `qosBoundsModel.ts`
- **WHEN** they are read
- **THEN** the stylesheet contains no hex colour
- **AND** no import of the two source files names a path containing `pages/`
