## ADDED Requirements

### Requirement: Binding table of the chosen providers
THE `BindingTable` component SHALL show the rows that `bindingRowsOf` derives from a solution's binding and its compiled problem as a table inside a scroll region named by `label` (default `Chosen providers`), one row per bound task with the task, the chosen candidate, its provider when known and the candidate's own value for each feature of `bindingFeaturesOf`, the unit of each feature in its column header.

`req~frontend-rendering-binding-table~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/bindingTableModel.test.ts`; `frontend/src/components/rendering/BindingTable.test.tsx`; `frontend/src/components/rendering/bindingTableModel.ts`; `frontend/src/components/rendering/BindingTable.tsx`

The prop contract, the fixtures `PROBLEM`, `BINDING` and `COMPILED`, and the markup are in design.md §2 and §3. The
values are each chosen candidate's own declared values, never contributions or totals of the whole binding: those
depend on the workflow and are evaluated by the gateway (INTENT principle 3). The component and its model import
nothing from `pages/`.

#### Scenario: Rows with the compiled problem
- **GIVEN** `BINDING` and `PROBLEM`
- **WHEN** `bindingRowsOf(BINDING, PROBLEM)` is called
- **THEN** it returns exactly two rows, in the problem's task order
- **AND** the first is `{ task: 'pay', taskName: 'Payment', candidate: 'stripe', candidateName: 'Stripe Payments', provider: 'Stripe', values: { latency: 120, cost: 0.3, availability: 0.999 } }`
- **AND** the second is `{ task: 'ship', taskName: 'Shipping', candidate: 'dhl', candidateName: 'DHL Express', provider: 'DHL', values: { latency: { min: 200, max: 400 }, cost: null, availability: 0.99 } }`

#### Scenario: Feature columns with their units
- **GIVEN** `PROBLEM`, then `null`
- **WHEN** `bindingFeaturesOf` is called with each
- **THEN** it returns `[{ name: 'latency', unit: 'ms' }, { name: 'cost', unit: 'EUR' }, { name: 'availability', unit: null }]`, then `[]`

#### Scenario: Rows without the compiled problem
- **GIVEN** `BINDING` and no problem
- **WHEN** `bindingRowsOf(BINDING, null)` is called
- **THEN** it returns exactly `[{ task: 'ship', taskName: 'ship', candidate: 'dhl', candidateName: 'dhl', provider: null, values: {} }, { task: 'pay', taskName: 'pay', candidate: 'stripe', candidateName: 'stripe', provider: null, values: {} }]`, in binding order

#### Scenario: A task the problem does not know
- **GIVEN** `PROBLEM` and the binding `{ audit: { resource: 'tools', id: 'logger' }, pay: { resource: 'payments', id: 'stripe' } }`
- **WHEN** `bindingRowsOf` is called
- **THEN** the rows are `pay`, then `audit`
- **AND** the `audit` row is `{ task: 'audit', taskName: 'audit', candidate: 'logger', candidateName: 'logger', provider: null, values: { latency: null, cost: null, availability: null } }`

#### Scenario: A candidate that is not eligible for its task
- **GIVEN** `PROBLEM` and the binding `{ pay: { resource: 'payments', id: 'paypal' } }`
- **WHEN** `bindingRowsOf` is called
- **THEN** it returns exactly `[{ task: 'pay', taskName: 'Payment', candidate: 'paypal', candidateName: 'paypal', provider: null, values: { latency: null, cost: null, availability: null } }]`

#### Scenario: Malformed bindings give no guessed rows
- **GIVEN** `PROBLEM` and the bindings `null`, `[]`, `'pay'`, then `{ pay: 'stripe', tax: { resource: 'fiscal' }, fee: { resource: 'fees', id: '' }, ship: { resource: 'carriers', id: 'dhl' } }`
- **WHEN** `bindingRowsOf` is called with each
- **THEN** the first three return `[]`
- **AND** the last returns exactly one row, whose `task` is `ship`
- **AND** no call throws

#### Scenario: The compiled form read by readBindingProblem
- **GIVEN** `COMPILED` read by `readBindingProblem`, and the binding `{ pay: { resource: 'payments', id: 'stripe' } }`
- **WHEN** `bindingRowsOf` and `bindingFeaturesOf` are called with the result
- **THEN** the rows are exactly `[{ task: 'pay', taskName: 'Payment', candidate: 'stripe', candidateName: 'Stripe Payments', provider: 'Stripe', values: { latency: 120 } }]`
- **AND** the features are exactly `[{ name: 'latency', unit: 'ms' }]`

#### Scenario: Region, columns and rows
- **GIVEN** `<BindingTable rows={bindingRowsOf(BINDING, PROBLEM)} features={bindingFeaturesOf(PROBLEM)} />`
- **WHEN** it is rendered
- **THEN** a region named `Chosen providers` with `tabindex="0"` holds one table whose `min-width` style is `680px`
- **AND** the column headers read exactly `Task`, `Candidate`, `Provider`, `latency (ms)`, `cost (EUR)` and `availability`, each with `scope="col"`
- **AND** the body has two rows whose row headers, with `scope="row"`, read `Payment` and `Shipping` in that order

#### Scenario: Names, ids, provider and values of a row
- **GIVEN** the table of the scenario "Region, columns and rows"
- **WHEN** the `Payment` row is read
- **THEN** its row header shows `Payment` and a `<code>` reading `pay`
- **AND** its cells read `Stripe Payments` with a `<code>` reading `stripe`, then `Stripe`, `120`, `0.3` and `0.999`
- **AND** no row and no column holds a total

#### Scenario: A range and a missing value
- **GIVEN** the table of the scenario "Region, columns and rows"
- **WHEN** the `Shipping` row is read
- **THEN** its `latency (ms)` cell reads `200–400` and its `availability` cell reads `0.99`
- **AND** its `cost (EUR)` cell holds `—` in an `aria-hidden="true"` element and `no value` in an `.sr-only` element

#### Scenario: Value formats
- **GIVEN** one row whose `latency` values are, in four renders, `{ min: null, max: 500 }`, `{ min: 100, max: null }`, `{ min: null, max: null }` and `1234.5678`, with `features={[{ name: 'latency', unit: 'ms' }]}`
- **WHEN** each is rendered
- **THEN** the `latency (ms)` cell reads `≤ 500`, `≥ 100`, `unbounded` and `1,234.5678`
- **AND** no cell repeats the unit `ms`

#### Scenario: Without the compiled problem
- **GIVEN** `<BindingTable rows={bindingRowsOf(BINDING, null)} />`
- **WHEN** it is rendered
- **THEN** the column headers read exactly `Task` and `Candidate`, and the table's `min-width` style is `320px`
- **AND** the first row header holds only a `<code>` reading `ship`, and its candidate cell only a `<code>` reading `dhl`

#### Scenario: Provider column only when a provider is known
- **GIVEN** `<BindingTable rows={bindingRowsOf({ pay: { resource: 'payments', id: 'paypal' } }, PROBLEM)} features={bindingFeaturesOf(PROBLEM)} />`, then `rows={bindingRowsOf({ pay: { resource: 'payments', id: 'paypal' }, ship: { resource: 'carriers', id: 'dhl' } }, PROBLEM)}` with the same `features`
- **WHEN** each is rendered
- **THEN** the first has no column header `Provider`, and its three feature cells read `no value`
- **AND** the second has a column header `Provider`, the `Payment` row's provider cell reads `no value` and the `Shipping` row's reads `DHL`

#### Scenario: A feature the row does not carry
- **GIVEN** the rows of `bindingRowsOf(BINDING, PROBLEM)` and `features={[{ name: 'energy', unit: 'J' }]}`
- **WHEN** it is rendered
- **THEN** there is a column header `energy (J)` and both cells of that column read `no value`

#### Scenario: No binding assignment
- **GIVEN** `<BindingTable rows={[]} />`
- **WHEN** it is rendered
- **THEN** it shows the text `This solution carries no binding assignment.`
- **AND** there is no table and no region named `Chosen providers`

#### Scenario: Custom label
- **GIVEN** `<BindingTable rows={bindingRowsOf(BINDING, null)} label="Solution 2 providers" />`
- **WHEN** it is rendered
- **THEN** the table is inside a region named `Solution 2 providers` and there is no region named `Chosen providers`

#### Scenario: Strings from the engine render as text
- **GIVEN** `<BindingTable rows={[{ task: '<img src=x onerror=alert(1)>', taskName: '<img src=x onerror=alert(1)>', candidate: '<b>x</b>', candidateName: '<b>x</b>', provider: null, values: {} }]} />`
- **WHEN** it is rendered
- **THEN** the row header reads `<img src=x onerror=alert(1)>` as text and the candidate cell reads `<b>x</b>` as text
- **AND** the table holds no `img` element, no `b` element and no `<pre>`

#### Scenario: Tokens only and no page imports
- **GIVEN** `frontend/src/components/rendering/BindingTable.css`, `BindingTable.tsx` and `bindingTableModel.ts`
- **WHEN** they are read
- **THEN** the stylesheet contains no hex colour
- **AND** neither source has an `import` whose path contains `pages/`
