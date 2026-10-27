# Design: m23-objective-breakdown

Status: specified, nothing built. Slice O1 of M2.3 (`docs/agent-work/m23-run-result/handoff.md`, row O1 and "Prop
contracts"). Fixed inputs: ROADMAP M2.3, ARCHITECTURE §5.3 (`ObjectiveBreakdown`: "weighted terms of the objective")
and §5.1, ADR-0014, constitution Articles 11 and 15, the M2.1 catalogue (`openspec/changes/m21-rendering-catalogue/`),
and the canonical objective evaluation of bim-engine/v1 (intake F11).

## 1. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Files | `frontend/src/components/rendering/ObjectiveBreakdown.{tsx,css,test.tsx}`, `objectiveModel.ts` and `objectiveModel.test.ts`; named exports, imported by path, no `index.ts`, like the M2.1 catalogue | a page-local component under `pages/Jobs/`: Jobs and Workbench both show it (J1, W1), and ARCHITECTURE §5.3 also lists it for study cells |
| Input types | structural types declared in `objectiveModel.ts`; the component and the model import nothing from `pages/` or `api/` | importing `BindingModel` from `pages/Cases/bindingModel.ts`: a component would depend on a page. `readBindingProblem`'s output fits the structural `ObjectiveProblem` type as it is (§2), so J1 and W1 pass it without mapping |
| Score and penalty | shown as the objective evaluation gives them; the component never recomputes or compares them | recomputing the score from the terms in the client: the gateway's re-evaluation is the authority (INTENT principle 3), and the score formula depends on the type and scalarization (§4) |
| Weighted loss | the model computes `weighted = loss × weight` per term, and the component sums them in a `Total weighted loss` row when the scalarization is `weighted-sum` and the score is not a list. These are display aids that show how a weighted-sum score is built (score = total weighted loss + penalty), nothing else | no weighted column: the reader could not see why a weighted-sum score has its value. Weight columns for every scalarization: outside a weighted sum the weights are `0` or meaningless (the compiler sets `0` when the execution names no weight), and would mislead |
| List scores | one item per score position in an ordered list named `Score`: position `i` takes the criterion of term `i`, the next position `Penalty`, later positions `Entry <i+1>` | showing the list as one comma-joined value: the reader must match positions to criteria by hand. A per-row score column: the penalty entry has no row |
| Direction | words, never arrows or colour: `minimize` → `lower is better`, `maximize` → `higher is better`; from the compiled problem only, matched by criterion id | reading a direction from the loss sign: a normalised loss is always lower-is-better, so the sign does not tell the direction |
| Units | the term carries `unit` from the compiled problem's feature, matched by feature name, and the value cell shows `<value> <unit>` | no unit: the handoff's term shape lists none. Adding `unit` is additive and J1 only passes the model output through (§2) |
| Missing data | a missing cell is `—` (`aria-hidden`) plus `.sr-only` `no value`, as in `MetricCards`; a missing direction or unit is never guessed | omitting the cell: the table columns would shift |
| Number format | `new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })`, as in `MetricCards` | a shared formatter module: none exists in `components/rendering/`, and a new shared file is outside this slice's owned files |
| Table | the `components/ui` `DataTable` (a named, focusable horizontal scroll region) so the seven columns scroll on a 390 px screen | a plain `<table>`: it would squeeze or overflow on mobile |
| Text | English, in the component (constitution 12); every string from the data renders as React text | an i18n layer: none exists |

## 2. Contract

```ts
// objectiveModel.ts
export interface ObjectiveTerm {
  criterion: string;                           // component.criteria, or `criterion <n>` (1-based) when not a non-empty string
  feature: string | null;                      // component.feature.id, or component.feature when it is a string
  direction: 'minimize' | 'maximize' | null;   // from problem.criteria[id === criterion].direction; null without a problem
  unit: string | null;                         // from problem.features[feature].unit; null without a problem
  value: number | null;                        // finite numbers only, else null (also loss and weight)
  loss: number | null;
  weight: number | null;
  weighted: number | null;                     // loss × weight when both are numbers, else null
}
export interface ObjectiveProblem {            // structural; readBindingProblem's BindingModel fits it
  criteria: Array<{ id: string; direction: 'minimize' | 'maximize' | null }>;
  features?: Record<string, { unit: string | null }>;
}
export interface ObjectiveBreakdownData {
  terms: ObjectiveTerm[];
  penalty: number | null;                      // a finite number, else null
  score: number | Array<number | null> | null; // a finite number, a list (non-finite entries → null), else null
  scalarization: string | null;                // a string, else null
}
export function objectiveTermsOf(objectives: unknown, problem: ObjectiveProblem | null): ObjectiveBreakdownData | null;

// ObjectiveBreakdown.tsx
interface ObjectiveBreakdownProps extends ObjectiveBreakdownData {
  label?: string;                              // default 'Objective breakdown'
}
export function ObjectiveBreakdown(props: ObjectiveBreakdownProps);
```

This is the handoff's contract `ObjectiveBreakdown({ terms, penalty, score, scalarization, label = 'Objective
breakdown' })` with the term `{ criterion, feature, direction, value, loss, weight, weighted }`, plus the term field
`unit`. J1 renders `const data = objectiveTermsOf(solution.objectives, problem)` as
`data && <ObjectiveBreakdown {...data} />`, so `null` (no canonical evaluation) means the run result leaves the
component out.

Model rules:
- `objectives` is canonical when it is a plain object (not an array) whose `components` is an array; otherwise the
  model returns `null`. The earlier frontend shape with `mode` and no `components` (intake F12) is therefore `null`,
  never a guessed breakdown.
- One term per component, in the given order (it is the score order of a list score). A component that is not an object
  still gives a term, `criterion <n>` with every other field `null`, so the positions of a list score stay aligned.
- `objectives.type` is not read: the score's shape (number or list) and the scalarization say what the reader needs.

Markup:
- `<section aria-label={label}>` (role `region`) with, in order:
  1. a `<dl>`: `<dt>Scalarization</dt>` and the text; `<dt>Score</dt>` and the formatted number, or, for a list,
     `<ol aria-label="Score">` with one `<li>` per position reading `<name>: <number>` (§1, List scores);
     `<dt>Penalty</dt>` and the formatted number;
  2. with no terms, `<p>No objective terms</p>` and no table;
  3. otherwise `DataTable` with `label="Objective terms"`: `<thead>` with `<th scope="col">` `Criterion`, `Feature`,
     `Direction`, `Value`, `Loss` and, when `scalarization === 'weighted-sum'`, `Weight` and `Weighted loss`;
     `<tbody>` with one `<tr>` per term, the criterion in `<th scope="row">`; and, when `scalarization ===
     'weighted-sum'` and `score` is not an array, a `<tfoot>` row with `<th scope="row">Total weighted loss</th>` and
     the sum of `weighted` (the dash when any `weighted` is `null`), spanning to the last column.
- Value cell: the number, then ` <unit>` when the value is not `null` and `unit` is given.
- React keys: the criterion plus the position. No `<pre>`, no `JSON.stringify`, no `dangerouslySetInnerHTML`.
- `ObjectiveBreakdown.css`: tokens of `styles/globals.css` only, no hex colour; number cells right-aligned
  (tables already get `font-variant-numeric: tabular-nums` from `globals.css:280`).

## 3. Test fixtures

```ts
const OBJ_SINGLE = {
  type: 'SINGLE', scalarization: 'weighted-sum', penalty: 2, score: 2.375,
  components: [
    { criteria: 'fast', feature: { resource: 'app', id: 'latency' }, value: 350, loss: 0.25, weight: 0.5 },
    { criteria: 'reliable', feature: { resource: 'app', id: 'availability' }, value: 99.5, loss: 0.5, weight: 0.5 },
  ],
};                                   // 0.25 × 0.5 + 0.5 × 0.5 + 2 = 2.375, exact in binary floating point
const OBJ_LEX = { ...OBJ_SINGLE, type: 'MULTI', scalarization: 'lexicographic', penalty: 0, score: [0.25, 0.5, 0],
  components: OBJ_SINGLE.components.map((c) => ({ ...c, weight: 0 })) };
const PROBLEM = {
  criteria: [{ id: 'fast', direction: 'minimize' }, { id: 'reliable', direction: 'maximize' }],
  features: { latency: { unit: 'ms' }, availability: { unit: '%' } },
};
```

`lexicographic` stands for any scalarization other than `weighted-sum`: scalarizations are ids that engine modes
declare (`bim_core/compat.py:412-445`), so the component shows the string and gives no meaning to it beyond
`weighted-sum`.

## 4. Where the data comes from

The canonical solution's `objectives` is `{ type, scalarization, components[{ criteria, feature, value, loss, weight
}], penalty, score }` (`bim_core/protocol.py:55-57`, `:166-199`). The compiler builds it in `evaluate_objectives`
(`bim_core/compiler.py:4325-4367`): `loss` is the value normalised and turned lower-is-better when the criterion has a
`normalize` range, else the value (minimize) or its negation (maximize); `weight` comes from the execution's weights
and is `0` when the execution names none; `score` is the penalty under `feasibility`, `Σ loss × weight + penalty` under
`SINGLE` `weighted-sum`, and `[loss…, penalty]` otherwise. `feature` is a reference `{ resource, id }`
(`protocol.py:101-109`). The gateway keeps these fields when it re-evaluates (intake F11). Direction and unit are not in
the solution; they come from the compiled problem the run used (`jobsApi.ir`, read by `readBindingProblem`, intake
F13), which J1 and W1 pass in.

## 5. Requirement and slices

| Requirement | Slice |
|---|---|
| `frontend-rendering-objective-breakdown` | O1 tests first (T), then O1 implementation (I) |

The model test carries `[utest->req~frontend-rendering-objective-breakdown~1]`, so does the component test; the model
and the component carry `[impl->req~frontend-rendering-objective-breakdown~1]`.

## 6. Risks

- R-a (intake §4): the figures may be empty on real runs because today's screens read `metrics` and `mode`. This
  component reads only the canonical `components`; J1's preview run confirms it on a real job.
- Engines that report a score in another shape (for example a list under `weighted-sum`) are shown as given, without the
  total row; the gateway's protocol checks are the authority on validity (`protocol.py:166-199`).
- A compiled problem whose criterion ids differ from the components' `criteria` gives no direction: the cell shows
  `no value` instead of a guess.
- `Weighted loss` is computed in the client from the gateway's numbers. It cannot disagree with the score in a
  `SINGLE` `weighted-sum` run, except by floating-point rounding beyond the three shown decimals.
- Accessibility is checked by roles, names and text (constitution 11 GAP: no automated WCAG scan). jsdom has no
  layout, so the mobile scroll is checked by ui-qa at 390×844 on the J1 preview, not by a unit test.

## 7. Deviations

- G1 (`openspec validate m23-objective-breakdown --strict`) is not registered for the spec task and was not run; CI's
  `openspec validate --strict --all` or a later registered check is the evidence (intake F16).
- The term carries `unit`, which the handoff's term shape does not list (§1, §2). The change is additive.

## 8. Rollback

All files are new and no screen imports them until J1; reverting the PR removes them.
