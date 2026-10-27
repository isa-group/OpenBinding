# Design: m23-qos-against-bounds

Status: specified (slice Q1 of `docs/agent-work/m23-run-result/handoff.md`); nothing built. Fixed inputs: ROADMAP M2.3,
ARCHITECTURE §5.2 and §5.3, INTENT principle 3, the M2.1 catalogue (`m21-rendering-catalogue`, design.md §1–§3), the
canonical solution shape (intake F11) and the compiled form (intake F13).

## 1. Context

The run result carries, per solution, the gateway's re-evaluated `features` (older fixtures: `metrics`, intake F12) and
`violations`. A violation is `{ constraint: { resource, id }, enforcement: 'hard' | 'soft', penalty: number,
message?: string }` (`bim-core` `protocol.py:206-217`); the gateway evaluates a constraint only when its `when` holds and
appends a violation only when its `assert` is false (`compiler.py:4300-4323`). Capacity rules of a placement model
produce violations whose reference is not in `spec.constraints` (`compiler.py:4154`).

The bounds are not in the job result. They come from the compiled form the run used (`GET /v1/jobs/{id}/ir`): its
`spec.constraints` is a list of `{ ref: { resource, id }, enforcement, when, assert, penalty? }`, where `when`, `assert`
and `penalty` are expression trees (`{ kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features',
'latency'] }, right: { kind: 'literal', value: 600 } }`, intake F13). The units are in
`spec.application.features[<feature>].unit`.

## 2. Prop contract (J1 and W1 rely on it)

Both files are new under `frontend/src/components/rendering/`. The types are declared and exported by the model file;
the component imports them from there. Neither file imports from `pages/` (intake §2.2), so the model carries its own
formula notation (§4).

```ts
// qosBoundsModel.ts
export type BoundOp = 'lt' | 'lte' | 'gt' | 'gte';

export interface QoSBound {
  rule: string;                     // the constraint's ref.id
  feature: string;                  // the quality: `latency` for the path features.latency
  op: BoundOp;                      // as read with the quality on the left (flipped when the number is on the left)
  limit: number;
  value: number | null;             // features[feature] when a finite number, else null
  unit: string | null;              // units[feature] when a non-empty string, else null
  enforcement: 'hard' | 'soft';
  met: boolean | null;              // from the violations only (§3)
  penalty?: number;                 // only when met is false and enforcement is 'soft'
}

export interface QoSRule {
  rule: string;
  text: string;                     // the assert as a formula (§4), or the violation's message (§3, rule 5)
  when: string | null;              // the when as a formula; null when absent or the literal true
  enforcement: 'hard' | 'soft';
  met: boolean | null;
  penalty?: number;
}

export function qosBoundsOf(
  constraints: unknown,                              // the compiled form's spec.constraints
  features: Record<string, unknown> | null | undefined, // the solution's features (the caller picks features ?? metrics)
  violations: unknown,                               // the solution's violations
  units?: Record<string, string | null>,             // the compiled form's application.features[*].unit
): { bounds: QoSBound[]; rules: QoSRule[] };
```

```ts
// QoSAgainstBounds.tsx
interface QoSAgainstBoundsProps {
  bounds: QoSBound[];
  rules: QoSRule[];
  label?: string;                   // default 'QoS against bounds'
}
export function QoSAgainstBounds(props: QoSAgainstBoundsProps): JSX.Element;
```

Differences from the handoff's contract, both additive: `qosBoundsOf` takes an optional fourth argument `units`, because
the bound carries a `unit` and none of the three handoff inputs holds one; `QoSRule` carries the optional `penalty` too,
so a violated soft rule shown as text states its penalty like a bound row does. `unit` is `string | null`.

J1 calls `qosBoundsOf(ir.spec.constraints, solution.features ?? solution.metrics, solution.violations, unitsOf(ir))`
and passes `[]` as constraints when the compiled form is not available; then only violations show, as rules (§3, rule
5).

## 3. Derivation rules (`qosBoundsOf`)

The model is tolerant like `readBindingProblem`: what does not have the expected shape is left out, never guessed and
never an error.

1. Constraints: a non-array reads as `[]`. An entry without a non-empty string `ref.id` is skipped. `enforcement` is
   `'soft'` when the entry says `soft`, else `'hard'`. Order follows the list.
2. A constraint is a **bound rule** when its `when` is absent or the literal `true`, and its `assert`, after flattening
   nested `and` nodes left to right, consists only of comparisons each of which has the op `lt`, `lte`, `gt` or `gte`,
   one side a path of exactly two segments whose first is `features`, and the other side a literal whose value is a
   finite number. It yields one `QoSBound` per comparison, in that order. With the literal on the left the op is
   flipped (`lt`↔`gt`, `lte`↔`gte`), so `2 ≤ features.cost` reads `cost ≥ 2`. Every other constraint is a **text rule**
   and yields one `QoSRule`: an `and` with one conjunct that is not such a comparison makes the whole constraint a text
   rule, never a partial bound.
3. Violations: a non-array means the gateway reported none for this solution, and every `met` is `null`. In an array,
   an entry is used only when `constraint.id` is a non-empty string; a constraint and a violation match when both
   `resource` and `id` of their references are equal.
4. `met` is `false` when at least one violation matches, `true` when the array holds none that matches, and `null` when
   there is no array. `penalty` is set only when `met` is `false` and the enforcement is `soft`: the sum of the matching
   violations' finite, non-negative `penalty` values. All bounds of one rule share its `met` and `penalty`: the status
   belongs to the rule, not to one comparison.
5. A used violation that matches no constraint (a placement capacity rule, or a run whose compiled form is not
   available) yields a `QoSRule` after the constraints, in the order of the violations, one per distinct reference:
   `rule` is its `constraint.id`, `text` the first non-empty string `message` among the violations of that reference,
   else `Reported by the gateway; not a rule of the compiled problem.`, `when` null, `enforcement` `soft` when the first
   violation of that reference says so, else `hard`, `met` false, and the `penalty` of rule 4.
6. `value` is `features[feature]` when it is a finite number, else `null` (also when `features` is null or undefined).
   The model never compares `value` with `limit`.

## 4. Formula notation

The same notation as `describeExpression` in `pages/Cases/bindingModel.ts:98-126`, copied because the component may not
import from `pages/` (§2): a literal string in curly quotes (`“eu”`), `none` for null, other literals as `String(value)`;
a path as its segments joined by `.`; `not x`, `−x`, `a and b`, `a or b`; compare and arithmetic ops as `=`, `≠`, `<`,
`≤`, `>`, `≥`, `+`, `−`, `×`, `÷`, `^`; a call as `name(a, b)`; an operand that is itself an `and`, `or`, compare or
arithmetic node in parentheses; anything else, or a depth over 8, as `…`. So
`features.cost + features.fee ≤ 12` reads `(features.cost + features.fee) ≤ 12`.

## 5. Rendering (`QoSAgainstBounds`)

| Part | Choice |
|---|---|
| Container | a `<section>` named by `label` (role `region`) |
| Bounds | when `bounds` is non-empty: the `components/ui` `DataTable` labelled `Bounds` (its own scroll region, default `minWidth`, so a phone scrolls sideways), with `scope="col"` headers `Rule`, `Quality`, `Kind`, `Bound`, `Value`, `Margin`, `Status`, one row per bound in order |
| Cells | Rule: the id in `<code>`. Quality: the feature name. Kind: `must` (hard) or `should` (soft), the words of `rulesText` on the Cases screens. Bound: the op symbol (`<`, `≤`, `>`, `≥`), a space, the limit and, when `unit` is set, a space and the unit (`≤ 600 ms`). Value: the value and unit (`412 ms`) |
| Margin | the absolute difference of value and limit, with the unit and the word `below` when value < limit, `above` when value > limit (`188 ms below`, `1.5 EUR above`), `at the limit` when equal. A position, never a verdict: it may read `above` on a `met` row of a `≤` bound, because the status comes from the gateway |
| Missing value | Value and Margin show `—` in an `aria-hidden="true"` element and `no value` in an `.sr-only` element, as `MetricCards`; no unit |
| Status | a `components/ui` `Badge` with the word `met` (variant `success`), `violated` (`error` for hard, `warning` for soft) or `not checked` (`default`); after it, when `penalty` is set, the text `penalty <n>`. Status is never colour alone (constitution 11.1) |
| Other rules | when `rules` is non-empty: a list named `Other rules`, one item per rule in order: the id in `<code>`, the text, `applies when <when>` when `when` is set, the kind word, and the status as in the table |
| Not checked | when there is at least one row and every row has `met` null: the paragraph `Not checked: this solution carries no violations list from the gateway.` before the table |
| Empty | when both lists are empty: only the text `No rules to check.` |
| Numbers | `Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })` for limit, value, margin and penalty, as `MetricCards` |
| Text | rule ids, formulas and gateway messages render as React text children only: no HTML is interpreted, no `<pre>`, no `JSON.stringify` |
| Styles | `QoSAgainstBounds.css` uses tokens only, no hex colour |

React keys: the row position plus the rule id, since one rule may yield several bounds.

## 6. Risks

- Only `features.<f> <op> <number>` rules are positioned (intake R-b). A rule written with a negative literal
  (`negate`), `=`, a per-task path or arithmetic shows as text with its status, without a value or margin.
- A rule with a condition is always a text rule (intake R-c). When the condition did not hold, the gateway reports no
  violation and the rule reads `met`; the `applies when …` line tells the reader the rule is conditional.
- The margin of a `met` row can read `above` a `≤` bound, or a `violated` row `below` it, if the gateway's evaluation
  differs from the shown value (rounding, a different solution): the status follows the gateway on purpose (INTENT
  principle 3); the review of J1 checks a real run.
- The formula notation is a second copy of `describeExpression` (§4): a later change of one does not change the other.
  Follow-up for M9.3 (shared layer).
- ui-qa (1440×900 and 390×844) needs a page: until J1 wires the component, the evidence is the unit tests; J1's preview
  carries the screenshots.

## 7. Requirement, tests and rollback

| Requirement | Tests |
|---|---|
| `frontend-rendering-qos-against-bounds` | `components/rendering/qosBoundsModel.test.ts` (rules of §3 and §4), `components/rendering/QoSAgainstBounds.test.tsx` (§5) |

Tests carry `[utest->req~frontend-rendering-qos-against-bounds~1]`; `qosBoundsOf` and `QoSAgainstBounds` carry
`[impl->req~frontend-rendering-qos-against-bounds~1]`. Rollback: delete the new files; nothing imports them before J1.
