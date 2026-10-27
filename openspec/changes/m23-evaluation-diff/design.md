# Design: m23-evaluation-diff

Status: specified (slice E1 of M2.3); tests first and the implementation are open (tasks.md). Fixed inputs: ROADMAP
M2.3, ARCHITECTURE §5.2 (run page) and §5.3 (`EvaluationDiff`: "engine-claimed versus gateway-evaluated values and
downgrade reasons", used in the run result), ADR-0014 and constitution Articles 11 and 15, the plan of M2.3 in
`docs/agent-work/m23-run-result/handoff.md` (row E1 and the `EvaluationDiff` prop contract) and its facts F11, F12, F14
and F16 in `intake.md`, and the catalogue conventions of `m21-rendering-catalogue` (design.md §1 to §3).

## 1. Context

- The gateway re-evaluates every engine answer. A canonical solution carries `features` and `objectives.{type,
  scalarization, components, penalty, score}`, where `score` is a number for a SINGLE weighted-sum run and a list
  otherwise (F11). Some frontend fixtures and screens still use `metrics` (F12).
- What the engine claimed (its termination, features and objectives) is in no API response today. `GET
  /v1/jobs/{id}/report` returns `gatewayEvaluation` and `remote`, which is only the engine's provenance; a real engine
  fills `remote.termination`, `remote.solutions` or `remote.divergence` only if it writes them there (F14). The gateway
  records no reason when it downgrades a termination or drops a solution.
- So the component ships in two steps (intake §2.5). In M2.3 (J1) the page passes `evaluated` and, when the provenance
  holds them, the engine's `notes`; the component then says that the claimed values are not kept for this run. If the
  owner chooses option A of CRP-M23-1, the slices C1 and J2 add `engineClaimed` and `downgrades` to the report and pass
  them as `claimed` and `downgrades`, with no change to this component.
- Everything in `claimed`, `notes` and `downgrades` comes from, or quotes, an engine, which is external input
  (the M2.3 plan rates E1 "medium, external input" and adds security-auditor to its review panel). An engine can send any JSON: wrong types, huge strings, markup, Unicode direction
  controls and property names such as `__proto__`.

## 2. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Files | `frontend/src/components/rendering/EvaluationDiff.tsx`, `EvaluationDiff.css`, `EvaluationDiff.test.tsx`, `evaluationDiffModel.ts`, `evaluationDiffModel.test.ts`; imported by path, no `index.ts`; nothing imported from `pages/` (handoff decisions) | the comparison inside the component: the pure model is tested without rendering and is reusable by J2 |
| Props | the handoff contract `{ evaluated, claimed?, notes?, downgrades? }`, plus an optional `label` (default `Claimed and evaluated values`) that names the region, as `MetricCards` and the other M2.3 components do | a fixed region name: the page could not tell two instances apart. The addition is optional, so J1's use of the contract is unchanged |
| Where the claim comes from | props only; the component fetches nothing (m21 design §3) | reading `remote` in the component: `remote` is provenance, not the claim (F14, handoff "Ruled out") |
| Pairing of solutions | by position, and only when both sides have the same number of solutions; otherwise one `Solutions` row and a sentence saying why no per-solution rows are shown | matching by decision: the contract carries no decision; pairing by position with different counts could compare unrelated solutions and report invented differences |
| Tolerance | two numbers agree when `abs(a - b) <= 1e-9`, the absolute tolerance the project's engine and benchmark comparisons use (`docs/qa/ENGINES_JAVA_IR02.md` step 4, `test_icsoc_regression.py`) | exact equality: re-evaluation in another language can differ in the last bits; a relative tolerance: no precedent in the repository |
| Who decides | the component compares values and shows them; whether a claim was acceptable is the gateway's job, shown through `downgrades` (INTENT principle 3, handoff decision on violations) | computing downgrade reasons in the client: they need the mode's guarantees and the evidence, which only the gateway has |
| Engine strings | React text nodes inside `<bdi>`, shortened to 500 code points, with caps on rows (100) and notes (20) (§5) | Markdown or HTML rendering: no need, and it opens injection; no cap: an engine could make the run page unusable |
| Table | the `components/ui` `DataTable` (a focusable region named `Differences` that scrolls on narrow screens), `minWidth` 480 | a bare `<table>`: no horizontal scroll on 390 px screens |
| Text | English in the component, plain sentences, no possessive apostrophes in fixed texts (so tests match exact strings without typographic quotes) | an i18n layer: none exists |

## 3. Contract

`evaluationDiffModel.ts` (pure, no React):

```ts
/** Structural input: what the gateway evaluated or what the engine claimed for one run. */
export interface RunValues {
  termination: string | null;
  solutions: Array<{
    features?: Record<string, unknown>;
    metrics?: Record<string, unknown>;          // older shape, read when `features` is not an object (F12)
    score?: unknown;                            // number | number[]
    objectives?: { score?: unknown } & Record<string, unknown>;   // canonical place of the score (F11)
  }>;
}

export type DiffValue =
  | { kind: 'number'; value: number }
  | { kind: 'list'; values: number[] }
  | { kind: 'text'; text: string | null }       // a termination; null = no termination
  | { kind: 'absent' }
  | { kind: 'invalid' };

export type DiffField =
  | { kind: 'termination' }
  | { kind: 'solutions' }
  | { kind: 'feature'; name: string }
  | { kind: 'score'; component: number | null };   // 1-based component of a list score, or null

export interface DiffRow {
  solution: number | null;    // 1-based position; null for a run-level row
  field: DiffField;
  claimed: DiffValue;
  evaluated: DiffValue;
}

export interface EvaluationDiffView {
  status: 'no-claim' | 'agrees' | 'differs';
  evaluated: { termination: string | null; solutions: number };
  claimed: { termination: string | null; solutions: number } | null;
  paired: boolean;            // true when a claim is given and both sides have the same number of solutions
  rows: DiffRow[];            // every differing value, in the order of §4, not capped
}

export const TOLERANCE = 1e-9;
export const MAX_ROWS = 100;
export const MAX_NOTES = 20;
export const MAX_TEXT = 500;
export function evaluationDiffOf(evaluated: RunValues, claimed?: RunValues | null): EvaluationDiffView;
export function shortText(text: string): string;   // §5
```

`EvaluationDiff.tsx`:

```ts
export interface Downgrade {
  code: string;
  message: string;
  solution?: number;          // 0-based position in the engine's claimed solutions; shown as `Solution {n + 1}`
}
interface EvaluationDiffProps {
  evaluated: RunValues;
  claimed?: RunValues | null;
  notes?: string[];
  downgrades?: Downgrade[];
  label?: string;             // default 'Claimed and evaluated values'
}
export function EvaluationDiff(props: EvaluationDiffProps);
```

J1 maps the job result to `evaluated` (`termination`, `solutions`) and passes `notes` from
`report.remote.divergence.notes` when it is an array; J2 maps `engineClaimed` and `downgrades` after C1. Both pass the
solutions as they come: the model applies the `features ?? metrics` and `score ?? objectives.score` fallbacks itself.

## 4. Comparison rules (`evaluationDiffOf`)

Reading, defensively, because `claimed` is external input and TypeScript types do not hold at run time:
- A termination that is not a string is `null`. `solutions` that is not an array counts as no solutions. A solution
  that is not a plain object has no features and no score.
- Features: the solution's `features` when it is a plain object (not null, not an array), else its `metrics` when that
  is a plain object, else none. Score: the solution's own `score` when it is not `undefined`, else `objectives.score`
  when `objectives` is a plain object, else absent.
- Keys are the object's own enumerable string keys (`Object.keys`), looked up with `Object.hasOwn`. Results are arrays;
  no object is ever indexed or written with an engine key, so `__proto__`, `constructor` and similar names are ordinary
  feature names.

Kinds of a value: `number` (a finite number); `list` (an array whose items are all finite numbers; only for the score);
`absent` (no own key, `undefined` or `null`); `invalid` (anything else: a string, a boolean, an object, a non-finite
number, an array as a feature value, an array score with a non-number item).

Equality: two `absent` values agree; two `number` values agree within `TOLERANCE`; `invalid` never agrees, not even with
`invalid`; any other pair of kinds differs. Two `list` scores of the same length are compared item by item, each
differing item giving its own row with `component` k (1-based); lists of different lengths, or a list and a number,
give one `Score` row with `component` null.

Rows, in this order:
1. `termination` (solution null), when the two terminations differ as strings (`null` equals only `null`).
2. `solutions` (solution null, `number` values), when the counts differ. Then `paired` is false and no other rows follow.
3. When `paired`, for each solution i from 1: its features, first the evaluated keys in their order, then the keys only
   the claim has, in the claim's order; then its score row or rows.

`status` is `no-claim` when `claimed` is `undefined` or `null` (then `claimed` is null, `paired` false, `rows` empty);
otherwise `agrees` when `rows` is empty and `differs` when it is not.

## 5. Engine text

Every string the component shows from `claimed`, `notes` and `downgrades`, and every feature name and termination in
the table, goes through one path:
- It is a React text child, never `dangerouslySetInnerHTML`, never parsed as Markdown or HTML, never put in an `href`,
  `src`, `style` or `className`, and never linkified. A note that looks like a URL stays text.
- It is wrapped in its own `<bdi>`, so Unicode direction controls (U+202A to U+202E, U+2066 to U+2069) in engine text
  cannot reorder the fixed text around it. The fixed texts of the component are outside those elements.
- `shortText` keeps it whole up to `MAX_TEXT` (500) code points; a longer string keeps its first 500 code points (by
  `Array.from`, so a surrogate pair is never split) followed by `…`. The full text stays available in the page's
  `SourceView` of the report (J1), not here.
- `EvaluationDiff.css` sets `overflow-wrap: anywhere` on the component, so a long word cannot widen the page.

Lists: `notes` keeps the items that are strings with non-whitespace text, in order, and shows at most `MAX_NOTES` (20),
then `{n} more notes are not shown.` (`1 more note is not shown.`). `downgrades` keeps the items whose `message` is a
non-empty string; `code` is shown only when it is a non-empty string, and `Solution {solution + 1}` only when
`solution` is a non-negative integer. The table shows the first `MAX_ROWS` (100) rows, then `{n} more differences are
not shown.` (`1 more difference is not shown.`); the summary line counts every row.

## 6. Markup and texts

A `<section aria-label={label}>` (role region) holding, in order:
1. One `<p>` summary line, where `{T}` is the termination or `no termination`, `{n} solution(s)` is singular for 1, and
   `{n} value(s)` is singular for 1:
   - `no-claim`: `The values the engine claimed are not kept for this run. Gateway evaluation: {T}, {n} solutions.`
   - `agrees`: `The engine claim agrees with the gateway evaluation: {T}, {n} solutions.`
   - `differs`: `The engine claim differs from the gateway evaluation in {n} values.`
2. When a claim is given and `paired` is false: `<p>Solutions are compared one by one only when both sides have the same
   number of solutions.</p>`
3. When there are rows: `DataTable` labelled `Differences` with `<th scope="col">` headers `Solution`, `Value`, `Engine
   claimed`, `Gateway evaluated`, and one `<tr>` per row (at most 100), then the "more differences" line.
   - Solution: `Run` for a run-level row, else the 1-based number.
   - Value: `Termination`, `Solutions`, the feature name, `Score` or `Score, component {k}`.
   - Values: a number through `Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })`; when both sides of a row
     are numbers that read the same at six decimals, both are shown with `String(value)` instead (so `120` and
     `120.000000002` stay apart); a list as its items in that format joined by `, `; a termination as its text or `no
     termination`; `absent` as `not stated` on the claimed side and `not evaluated` on the evaluated side; `invalid` as
     `not a number`.
4. When `downgrades` has items: `<ul aria-label="Why the gateway changed the result">`, one `<li>` per item with
   `Solution {k}` (when given), the message, and the code in `<code>`.
5. When `notes` has items: `<ul aria-label="Engine notes">`, one `<li>` per note, then the "more notes" line.

No `<pre>`, no `JSON.stringify` (constitution 15; the hygiene test of m21 needs no new entry). No colour carries
meaning; the stylesheet uses tokens only and no hex colour.

## 7. Requirement and tracing

| Requirement | Slice |
|---|---|
| `req~frontend-rendering-evaluation-diff~1` | E1 (S1 tests first, S2 implementation) |

`EvaluationDiff.tsx` and `evaluationDiffModel.ts` carry `[impl->req~frontend-rendering-evaluation-diff~1]`; both test
files carry `[utest->req~frontend-rendering-evaluation-diff~1]`.

## 8. Risks

- Until C1 merges, real runs show only the `no-claim` line and, sometimes, notes: the comparison code is exercised only
  by unit tests (intake §2.5). This is intended and stated on the page, not hidden.
- Pairing by position assumes both sides keep the engine's order. If the gateway drops a solution, the counts differ and
  no per-solution row is shown, which is safe; a reordering with equal counts would show differences that are real
  per position but not per decision. C1 is expected to keep the order; the J2 review checks it.
- The tolerance is absolute: for values above about 1e7, two floating-point results of the same sum can differ by more
  than 1e-9 and be shown as a difference. The project's other comparisons accept the same limit.
- Engine text: shortening hides the tail of a long note here; the source view of the report keeps it. `bdi` isolates
  direction controls but does not remove them, and confusable characters (homoglyphs) are not detected. A security
  review (security-auditor) covers §5.
- No routed page mounts the component before J1, so ui-qa at 1440×900 and 390×844 has no screen of its own in E1
  (tasks.md S3).
- The capability `frontend-rendering` exists only in the unarchived change `m21-rendering-catalogue`: archive m21
  before this change (intake R-f). This change only ADDs.

## 9. Rollback

All files are new and nothing imports them until J1; reverting the PR removes them.
