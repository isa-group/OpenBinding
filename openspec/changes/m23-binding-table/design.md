# Design: m23-binding-table

Status: slice B1 of M2.3, specified, nothing built. Fixed inputs: ROADMAP M2.3, ARCHITECTURE §5.3 (run page and
catalogue), INTENT principle 3, the M2.3 plan (`docs/agent-work/m23-run-result/handoff.md`, "Prop contracts", and
`intake.md` F3, F11–F13, F16, F18), the catalogue rules of `m21-rendering-catalogue` design.md §1 and §3 (merged, not
archived).

## 1. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Files | `components/rendering/BindingTable.tsx`, `BindingTable.css` (tokens only), `BindingTable.test.tsx`, `bindingTableModel.ts`, `bindingTableModel.test.ts`; named exports, imported by path, no `index.ts` (m21 §1) | the model inside the component file: the page slices call the model without rendering, and the model tests need no DOM |
| Inputs | structural types declared in `bindingTableModel.ts`; neither file imports from `pages/` (intake §2.2). The problem input is the subset of `BindingModel` (`pages/Cases/bindingModel.ts`) the table reads, so the value `readBindingProblem` returns is accepted as it is | importing `BindingModel` from `pages/Cases`: a catalogue component would depend on a screen; moving `bindingModel.ts` to a shared place: M9.3 (F18) |
| What a cell shows | the chosen candidate's own feature value, as declared in the compiled problem | "per-feature contributions" (ARCHITECTURE §5.3 catalogue row): a contribution depends on the workflow aggregation, which is the gateway's job (INTENT principle 3); the objective and QoS views (O1, Q1) show the evaluated figures |
| Columns | Task, Candidate, Provider (only when at least one row has a provider), then one per entry of `features`, in its order | always a Provider column: without the problem every provider is unknown, and the plan fixes "task and candidate only" for that case |
| Feature order | `bindingFeaturesOf` returns the features of the problem in declaration order (`problem.features` key order); a feature a chosen candidate does not declare reads `no value` | dropping columns that no chosen candidate fills: the column set would change between two solutions of one run |
| Row order | the problem's task order (`problem.tasks`), then the binding's tasks the problem does not know, in binding order; without a problem, binding order | the workflow order (`tasksOfFlow`): lives in `pages/Cases`, and the declaration order is stable across solutions |
| Candidate lookup | by `id` among the eligible candidates of the task in the problem (`TaskInfo.candidates`) | by catalogue (`resource`) and id: `readBindingProblem` drops the catalogue of each candidate; widening it touches `pages/Cases`, outside this slice (risk §6) |
| Malformed input | a `binding` that is not a plain object gives no rows; an entry whose value is not an object with a non-empty string `id` is left out; a problem of `null` gives the ids only. Never an error, never a guess (the gateway validated the decision, F11) | showing a stringified value: raw rendering, which the hygiene rule forbids |
| Value format | `formatFeature(value)` of `utils/featureRange.ts` without a unit (the unit is in the header): numbers in en-US with at most 6 decimals, ranges `200–400`, `≤ 500`, `≥ 100`, `unbounded` | a new formatter: two spellings of the same value across screens |
| Missing value | an `aria-hidden` `—` and an `.sr-only` `no value`, as `MetricCards` (m21 §2) | an empty cell: read as nothing by assistive technology |
| Scroll | the table is the child of `DataTable` (`components/ui/DataTable.tsx`), whose region carries `label`, `tabIndex={0}` and a horizontal scroller; `minWidth` is `320 + 120 × features.length` px | a page-level wrapper: J1 and W1 would each write it |

## 2. Prop contract (J1 and W1 rely on it)

```ts
// bindingTableModel.ts
export type BindingValue = number | { min: number | null; max: number | null };

export interface BindingRow {
  task: string;               // the key of decision.binding
  taskName: string;           // the problem's task name, else `task`
  candidate: string;          // the `id` of the bound reference
  candidateName: string;      // the problem's candidate name, else `candidate`
  provider: string | null;    // the problem's provider name (or provider id), else null
  values: Record<string, BindingValue | null>;  // one entry per feature of bindingFeaturesOf(problem); {} without a problem
}

export interface BindingFeature {
  name: string;               // feature id, e.g. 'latency'
  unit: string | null;        // e.g. 'ms'
}

/** The part of a compiled problem the table reads; `BindingModel` of readBindingProblem fits it. */
export interface BindingProblemShape {
  tasks: ReadonlyArray<{
    id: string;
    name: string;
    candidates: ReadonlyArray<{
      id: string;
      name: string;
      provider: string | null;
      features: Record<string, BindingValue>;
    }>;
  }>;
  features: Record<string, { unit: string | null }>;
}

export function bindingRowsOf(binding: unknown, problem: BindingProblemShape | null): BindingRow[];
export function bindingFeaturesOf(problem: BindingProblemShape | null): BindingFeature[];
```

```ts
// BindingTable.tsx
interface BindingTableProps {
  rows: BindingRow[];
  features?: BindingFeature[];   // column order; missing or [] → no feature column
  label?: string;                // accessible name of the scroll region, default 'Chosen providers'
}
export function BindingTable(props: BindingTableProps);
```

`binding` is `solution.decision.binding` of a canonical solution (`{ [task]: { resource, id } }`, F11). The caller
(J1, W1) computes `bindingRowsOf(solution.decision?.binding, problem)` and `bindingFeaturesOf(problem)`, with `problem`
from `readBindingProblem` of the compiled form the run used (F13) or `null` while it is not loaded.

Model rules:
- For a task known to the problem, `taskName` is its `name`. For a candidate found by id among that task's
  candidates, `candidateName`, `provider` and the feature values come from it; otherwise `candidateName` is the id,
  `provider` is `null` and every value is `null`.
- `values` holds exactly the names of `bindingFeaturesOf(problem)`; a feature the candidate does not declare is `null`.
- The model never reads `features`, `objectives`, `penalties` or `violations` of the solution.

Markup:
- `rows` empty: `<p>This solution carries no binding assignment.</p>`, no region and no table.
- Otherwise `<DataTable label={label} minWidth={320 + 120 * features.length}>` holding `<table>` with `<thead>` and
  `<tbody>`, class `rendering-binding`.
- Header cells `<th scope="col">`: `Task`, `Candidate`, `Provider` (when any row has a non-null provider), then each
  feature as `<name>` or `<name> (<unit>)` when the unit is not null.
- Each row: the task cell is `<th scope="row">` holding `taskName` followed by `<code>{task}</code>` when they differ,
  or `<code>{task}</code>` alone; the candidate cell the same with `candidateName` and `candidate`; the provider cell
  the provider or the missing-value pair; each feature cell `formatFeature(value)` or the missing-value pair.
- The React key of a row is `task` (a binding has one entry per task).
- Every string is rendered as React text; there is no `<pre>`, no `JSON.stringify` and no `dangerouslySetInnerHTML`.
- `BindingTable.css`: `.rendering-binding` rules for numeric cells (`text-align: end`,
  `font-variant-numeric: tabular-nums`) and the `<code>` spacing, with design tokens only (no hex colour).

## 3. Test fixtures (named in the scenarios)

`PROBLEM` (a `BindingProblemShape`):
- `features`: `latency` (`ms`), `cost` (`EUR`), `availability` (no unit), in this order.
- task `pay`, name `Payment`: candidate `stripe` (`Stripe Payments`, provider `Stripe`, `latency` 120, `cost` 0.3,
  `availability` 0.999) and candidate `adyen` (`Adyen`, provider `Adyen`, `latency` 90, `cost` 0.25).
- task `ship`, name `Shipping`: candidate `dhl` (`DHL Express`, provider `DHL`, `latency` `{ min: 200, max: 400 }`,
  `availability` 0.99; no `cost`).

`BINDING`: `{ ship: { resource: 'carriers', id: 'dhl' }, pay: { resource: 'payments', id: 'stripe' } }` (binding order
`ship`, `pay`).

`COMPILED`: a compiled form with `spec.application.tasks.pay` (`name: 'Payment'`, `requires.type: 'payment'`),
`spec.application.features.latency` (`unit: 'ms'`), `spec.eligibility.pay: [{ resource: 'payments', id: 'stripe' }]`
and `spec.candidates.payments` holding `providers['stripe-inc'].name: 'Stripe'` and `candidates.stripe` (`name:
'Stripe Payments'`, `provider.id: 'stripe-inc'`, `features.latency: 120`). The model test may import
`readBindingProblem` from `pages/Cases/bindingModel.ts` for this one case; the component and model files never do.

## 4. Requirement, tests and tags

| Requirement | Tests |
|---|---|
| `frontend-rendering-binding-table` | `components/rendering/bindingTableModel.test.ts` (model scenarios), `components/rendering/BindingTable.test.tsx` (rendering scenarios) |

Both test files carry `[utest->req~frontend-rendering-binding-table~1]`; `BindingTable.tsx` and
`bindingTableModel.ts` carry `[impl->req~frontend-rendering-binding-table~1]`.

Tests first (intake §2.4): the tests-first task writes both test files with a stub of both modules (final exports and
types; `bindingRowsOf` and `bindingFeaturesOf` return `[]`, `BindingTable` renders `null`) and overlays them in the
red_before check, so the tests fail by assertion, not by import.

## 5. Accessibility

- The scroll region is named by `label` and reachable by keyboard (`DataTable`, `tabIndex={0}`).
- Column and row headers carry `scope`, so a screen reader reads each value with its task and feature.
- The unit is part of the column header text, never conveyed by position or colour.
- A missing value is read `no value`.

## 6. Risks

- Candidate lookup by id only: if two catalogues of one task's eligible candidates share an id, the first one in
  eligibility order supplies the name, provider and values. Accepted for B1; a followup can carry `resource` in the
  problem model (`pages/Cases/bindingModel.ts`, outside this slice).
- The table shows declared candidate values, not the values the gateway evaluated for the whole binding, and has no
  total row. J1's ui-qa checks that the run page does not let them read as totals.
- ARCHITECTURE §5.3 describes the catalogue row as "with per-feature contributions"; this change deliberately does not
  (§1). The wording of ARCHITECTURE is the coordinator's (followup).
- Range values: a range candidate shows its range (`200–400`); no midpoint is computed.
- Size: about 160 non-test lines (component about 70, model about 70, CSS about 20), under the 300-line limit.

## 7. Rollback

All files are new and no screen imports them in this change; reverting the PR removes them.
