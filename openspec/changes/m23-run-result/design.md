# Design: m23-run-result

Status: the rest of M2.3 (`docs/agent-work/m23-run-result/handoff.md`, slices H1, J1 and W1, here H, J and W). Fixed
inputs: the six merged components in `frontend/src/components/rendering/` (`BindingTable`, `QoSAgainstBounds`,
`ObjectiveBreakdown`, `EvaluationDiff`, `TradeOffChart` and the `VerdictBadge` terminations), and the M2.1 catalogue
(`SourceView`, `LogPanel`, `MetricCards`), none of them archived yet. The props below are the props in the code at this
change's base. Where the handoff's prop contracts differ, the code wins.

## 1. Context

- Offender 1 is dead code. `EngineReportView` (`EngineReportView.tsx:121-202`) has no importer. Only
  `RegistrationReportView` is imported (`pages/EngineDetail/EngineDetail.tsx:16`, `EngineReportView.test.tsx:4`). The
  `.engine-report*`, `.engine-claimed`, `.divergence-notes` and `.divergence-hint` rules (`EngineReportView.css:1-35`,
  `:45-60`) serve only that function. The `.registration-report*` rules (`:37-43`) stay (intake F6).
- Offender 4 is a fallback string (`pages/Workbench/CheckResult.tsx:58`). The workbench `Diagnostic` has no severity, and
  each item is a button that opens its resource, so `DiagnosticsList` is ruled out (intake F9).
- Offender 2 (`pages/Jobs/JobResult.tsx`) has a local `SourceView` with a `<pre>` (:27-34), used for the solution
  (:103), the engine report (:154) and the swaps (:237). It also has the engine log in a `<pre>` (:283-288), a binding
  table without names or features (:88-102), and figures read from `metrics` and `objectives.mode` (:83-87).
- Offender 3 (`pages/Workbench/RunPanel.tsx`) has a decision table with a `<pre>` fallback (:12-31), and a `<pre>` dump
  of metrics, objectives, penalties, violations and evaluation (:52-55).
- The canonical solution has `features` and `objectives.{type, scalarization, components, penalty, score}`. The
  frontend reads `metrics` and `mode` (intake F11, F12), so the figures list is probably empty on real runs (R-a).
- Constraint bounds, task and candidate names, and units are not in the job result. They come from the compiled form
  the run used, `GET /v1/jobs/{id}/ir`, which returns the `BindingProblem` document itself
  (`openbinding-gateway/src/openbinding_gateway/routes/v1.py:1266-1286`). It answers 404 when the document is gone and
  409 `analysis_unavailable` when the job's and the snapshot's IR identities disagree. `readBindingProblem`
  (`pages/Cases/bindingModel.ts:246`) reads names, features with units and criteria from it.
- The engine's claimed values are in no API response. `report.remote` is the engine's provenance only (intake F14).

## 2. Contract: `RunResult`

Files: `frontend/src/components/rendering/RunResult.tsx`, `RunResult.css` (tokens only), `RunResult.test.tsx`,
`runResultModel.ts` and `runResultModel.test.ts`. Like every catalogue component, they are imported by path, with no
`index.ts`, and import nothing from `pages/` or `api/`.

```ts
// runResultModel.ts: structural inputs only
import type { BindingProblemShape } from './bindingTableModel';
import type { ObjectiveProblem } from './objectiveModel';

export interface RunResultData { termination?: unknown; solutions?: unknown; logs?: unknown }
/** What readBindingProblem(document) returns fits as it is. */
export type RunProblem = BindingProblemShape & ObjectiveProblem;
export interface RunReport { remote?: unknown }

export function verdictOf(termination: unknown): string;                    // non-empty string, else 'UNKNOWN'
export function solutionsOf(result: RunResultData): Record<string, unknown>[]; // plain objects only, in order
export function figuresOf(solution: Record<string, unknown>): Array<[string, number]>; // see below
export function optimizationTypeOf(solutions: Record<string, unknown>[]): string | null;
export function unitsOf(problem: RunProblem | null | undefined): Record<string, string | null>;
export function notesOf(report: RunReport | null | undefined): string[];
export function remoteOf(report: RunReport | null | undefined): Record<string, unknown> | null; // null when no own key

// RunResult.tsx
interface RunResultProps {
  result: RunResultData;
  /** undefined: not loaded yet; null: not available (no note is shown while loading). */
  problem?: RunProblem | null;
  /** The compiled document's spec.constraints, as qosBoundsOf reads them; [] when absent. */
  constraints?: unknown;
  report?: RunReport | null;
  /** Page content right after the summary (Jobs: the "Why no combination works" card). */
  notice?: ReactNode;
  /** Page content after the trade-off set, before the sources (Jobs: footnote and swaps panel). */
  children?: ReactNode;
  label?: string; // default 'Run result'
}
export function RunResult(props: RunResultProps);
```

Reading rules (`runResultModel.ts`, total, never throws, own keys only through `Object.hasOwn`):
- `figuresOf`: the solution's `features` when it is a plain object, else its `metrics` when that is a plain object,
  else nothing. The figures are the entries whose value is a finite number, in key order. `objectives.mode` is never
  read.
- `optimizationTypeOf`: `objectives.type` of the first solution where it is a non-empty string, else `null`.
- `notesOf`: `report.remote.divergence.notes` when it is an array, keeping its string items. `EvaluationDiff` drops
  the blank ones and caps them.

Markup: one `<section aria-label={label} className="rendering-run">`, holding in this order:

| # | Part | Shown when | Rendered as |
|---|---|---|---|
| 1 | Verdict | always | `<VerdictBadge verdict={verdictOf(result.termination)} />` |
| 2 | Summary | always | `<p>`: `{n} solution` / `{n} solutions`, plus ` · optimization {type}` when `optimizationTypeOf` is not null |
| 3 | Problem note | `problem === null` | `<p>The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.</p>` |
| 4 | Page notice | `notice` given | `notice` |
| 5 | No binding / choice | `n === 0` / `n > 1` | `<p>This run finished without producing a binding.</p>` / `<label>Show solution <select>` with options `Solution 1` … `Solution n`. The index is clamped to `n - 1` when the result changes |
| 6 | Quality figures | `n > 0` and the shown solution has ≥ 1 figure | `<MetricCards label="Quality of this combination" metrics={figures.map(([name, value]) => ({ id: name, label: name, value, unit: units[name] ?? undefined }))} />` |
| 7 | Binding | `n > 0` | `<BindingTable rows={bindingRowsOf(solution.decision?.binding, problem ?? null)} features={bindingFeaturesOf(problem ?? null)} />` |
| 8 | Bounds | `n > 0` | `<QoSAgainstBounds {...qosBoundsOf(constraints ?? [], features-or-metrics object, solution.violations, unitsOf(problem))} />` |
| 9 | Objective | `n > 0` and `objectiveTermsOf(solution.objectives, problem ?? null)` is not null | `<ObjectiveBreakdown {...data} />` |
| 10 | Claims | always | `<EvaluationDiff evaluated={{ termination: string or null, solutions }} notes={notesOf(report)} />`, never `claimed` or `downgrades` |
| 11 | Trade-offs | `tradeOffObjectivesOf(points).length >= 2`, with `points = tradeOffPointsOf(solutions)` | `<TradeOffChart points={points} objectives={objectives} />` |
| 12 | Page extras | `children` given | `children` |
| 13 | Sources | `n > 0` or `remoteOf(report)` is not null | `<details className="rendering-run__source">` (closed), `<summary>View source</summary>`, then `<SourceView source={solution} label="Solution {k} source" filename="solution-{k}.json" />` when `n > 0`, then `<SourceView source={remote} label="Engine report source" filename="engine-report.json" />` when not null |
| 14 | Log | `result.logs` is a non-empty string | `<LogPanel log={logs} title="Engine log" filename="engine.log" />` (closed), the last child |

`k` is the 1-based index of the shown solution. Every per-solution part (6 to 9 and the solution source) follows the
choice. The run-level parts (1, 2, 10 and 11) do not. `RunResult` itself renders no `<pre>` and no `JSON.stringify`.
`SourceView` and `LogPanel` are the only places that do (ARCHITECTURE §5.3). There is no heading in the component,
so each page keeps its own heading levels. `RunResult.css` sets only the vertical gap between parts
(`var(--space-4)`), with no hex colour.

## 3. Page wiring

### H: retire offenders 1 and 4
- `EngineReportView.tsx`: delete the `EngineReportView` function and its doc comment (:109-202), and the `EngineReport`
  type import. `RegistrationReportView` and `ReportDigest` stay as they are. In `EngineReportView.css`, delete the rules
  listed in §1 and keep `.registration-report*`.
- `CheckResult.tsx`: the item text is `textOf(item)`: `message` when it is a non-empty string, else `detail` when it
  is a non-empty string, else `The gateway sent no message for this diagnostic.`. The button, the code chip, the place
  line (`where`, which already shows the pointer, so the fallback does not repeat it), the fix and `onOpen` stay.
- The types `EngineReport` and `EngineDivergence` (`api/client.ts:353-368`) become unused. `api/client.ts` is shared
  with M4.4 and outside this change, so they are left for a followup (tasks.md).

### J: the Jobs page
- `pages/Jobs/useRunProblem.ts` (new): `useRunProblem(jobId: string | undefined, enabled: boolean)` returns
  `{ problem, constraints }`. It calls `jobsApi.ir(jobId)` once when it is enabled and has an id, and maps the document
  through `readBindingProblem`. It returns `problem: undefined` while loading, `null` on any failure (404, 409, 410,
  network) or when `readBindingProblem` returns null, and the model otherwise. `constraints` is
  `document.spec.constraints` when it is an array, else `[]`. The request is cancelled on unmount. W reuses the hook.
- `ResultSection`: the queued, running, cancelled and failed branches are unchanged and fetch nothing. For a completed
  job, it loads the problem (above) and `jobsApi.report(jobId)` once, in parallel. A failed report gives
  `report = null`, with no notice, because the report adds only notes and the engine report source. Then it renders
  `<RunResult result={detail.result ?? {}} problem constraints report notice={infeasible ? <Infeasible …/> : undefined}>`,
  with the footnote and `NeighborhoodPanel` as children when there are solutions and the run is not infeasible.
- Deleted from `JobResult.tsx`: the local `SourceView`, `Solutions`, `EngineReport` (the "Compare with the engine" card,
  replaced by `EvaluationDiff`), and the log `<details>`. `NeighborhoodPanel` shows its source as
  `<details><summary>View source</summary><SourceView source={result} label="Swaps source" /></details>`.
- `jobsModel.ts`: `bindingRows`, `metricEntries` and `scoreText` are deleted with their tests once nothing uses them.
  `violationsOf` and `outcomeOf` stay.
- `api/jobs.ts`, the `JobSolution` type only: it adds `features?: Record<string, unknown>` and
  `objectives.{type?, scalarization?}`, drops `objectives.mode`, and keeps `metrics?` as the older shape. This is a
  type change in the client only: no request or response changes.
- `test/fixtures/jobs.ts` moves to the canonical shape (`RESULT`, §5) and adds the compiled document behind `PROBLEM`
  and `CONSTRAINTS`.

### W: the workbench
- `RunPanel.tsx`: `DecisionView`, `Metrics` and `Solution` are deleted. Inside the `Authoritative result` region, the
  pane head (eyebrow and `h3`) stays, `.wb-result-summary` goes (the `RunResult` summary replaces it), and the solutions
  render as `<RunResult result={wb.result} {...useRunProblem(wb.resultJobId, Boolean(wb.result))} />`. A decision
  that is not a binding shows the `BindingTable` empty text, with its source in `View source`.
- `BindingAnalysis` (:142) stays. Its stale stub text is a followup.

## 4. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Location of `RunResult` | `components/rendering/RunResult.tsx`, as the task brief asks: it is the run-result entry of the catalogue, shared by two pages | `components/RunResult/RunResult.tsx` (handoff): a second folder for one composition. `widgets/` does not exist until M9.3 (F18) |
| Problem input | the page passes `readBindingProblem(document)` and `document.spec.constraints`, because the component may not import `pages/Cases/bindingModel.ts` | moving `readBindingProblem` into `components/`: it belongs to M9.3's `entities/` move; passing the raw document: the component would need the page's reader |
| Loading versus missing | `problem` `undefined` while loading (ids, no note), `null` when unavailable (ids and the note) | a separate `problemState` prop: one more prop for the same two states |
| Workbench problem source | `GET /v1/jobs/{resultJobId}/ir`, the form the run used | `wb.compiledIr` first (handoff): the compiled form shown in the editor can be from an earlier edit than the snapshot that ran, so names and bounds could belong to another package |
| Report loading on Jobs | fetched once with the compiled form for a completed job, failures silent | the "Compare with the engine" button: `EvaluationDiff` is a fixed part of the run page (ARCHITECTURE §5.2), and a button would hide the not-kept sentence |
| Engine claims | `EvaluationDiff` gets no `claimed`, so it says the values are not kept. `remote` goes only to the `Engine report source` | deriving a claim from `remote.termination` or `remote.solutions`: that is provenance, not the claim (F14, handoff "Ruled out"). The real claim needs CRP-M23-1, out of scope |
| Infeasible run | the `Why no combination works` card goes in the `notice` slot, after the verdict. The best attempt's parts follow under the `INFEASIBLE` badge, so `QoS against bounds` shows which rule fails | hiding the solution parts as today: it hides the violated bound that explains the verdict |
| Two slots | `notice` (after the summary) and `children` (before the sources) | one slot: either the infeasible card comes before the verdict or the swaps panel comes after the log, and both break the §5.2 order (verdict first, log last) |
| Quality figures | `MetricCards` of the shown solution's features, with units | dropping the figures: the Jobs page shows them today (`Quality of this combination`), and they are the only place a feature that no rule bounds appears |
| Optimization | `objectives.type` in the summary, and `scalarization` through `ObjectiveBreakdown` | `mode`: not in the canonical shape (F11, F12) |
| Log file name | `engine.log` | `job-<id>-engine.log`: `RunResult` has no job id, and the workbench run has one only sometimes |
| Spec layout | each requirement's statement, then its id line, `Needs:` and `Evidence:`, as in the merged sibling changes (`m21-rendering-catalogue`, `m23-*`) | the id line first: the capability would mix two layouts before its archive |

## 5. Fixtures (the spec's names; J adds them to `test/fixtures/jobs.ts`, and `RunResult.test.tsx` may inline them)

- `PROBLEM`, the fields of `readBindingProblem` that are read: tasks `t1` `Payment` (candidates `c1` `Stripe EU`,
  provider `Stripe`, `{ latency: 120, cost: 4 }`, and `c2` `Adyen`, provider `Adyen`, `{ latency: 90, cost: 5 }`), `t2`
  `Shipping` (`c3` `DHL`, provider `DHL`, `{ latency: 200, cost: 3 }`) and `t3` `Notify` (`c4` `Twilio`, provider
  `Twilio`, `{ latency: 100, cost: 2.5 }`). Features `{ latency: { unit: 'ms', direction: 'minimize' }, cost: { unit:
  'EUR', direction: 'minimize' } }`. Criteria `[{ id: 'cost', feature: 'cost', direction: 'minimize', range: null },
  { id: 'latency', feature: 'latency', direction: 'minimize', range: null }]`.
- `CONSTRAINTS`: `[{ ref: { resource: 'rules', id: 'max-latency' }, enforcement: 'hard', assert: { kind: 'compare',
  op: 'lte', left: { kind: 'path', segments: ['features', 'latency'] }, right: { kind: 'literal', value: 600 } } },
  { ref: { resource: 'rules', id: 'prefer-eu' }, enforcement: 'soft', assert: { kind: 'compare', op: 'eq', left: {
  kind: 'path', segments: ['features', 'region'] }, right: { kind: 'literal', value: 'eu' } } }]`. That is one hard
  bound and one soft rule that is not a bound.
- `RESULT`: `{ termination: 'FEASIBLE', logs: 'solve started\nsolve finished\n', solutions: [S1, S2] }`, with
  - `S1`: `decision { kind: 'binding', binding: { t1: { resource: 'catalog', id: 'c1' }, t2: { resource: 'catalog',
    id: 'c3' }, t3: { resource: 'catalog', id: 'c4' } } }`, `features { latency: 420, cost: 9.5 }`, `objectives {
    type: 'MULTI', scalarization: 'pareto', components: [{ criteria: 'cost', feature: 'cost', value: 9.5, loss: 0.3,
    weight: 1 }, { criteria: 'latency', feature: 'latency', value: 420, loss: 0.4, weight: 1 }], penalty: 2, score:
    [0.3, 0.4] }`, `violations [{ constraint: { resource: 'rules', id: 'prefer-eu' }, enforcement: 'soft', penalty: 2,
    message: 'Prefer EU providers' }]`;
  - `S2`: the binding `t1 → c2`, `t2 → c3`, `t3 → c4`, `features { latency: 560, cost: 7 }`, the same `type` and
    `scalarization`, the components `cost` (value 7, loss 0.2) and `latency` (value 560, loss 0.55), `penalty: 0`,
    `score: [0.2, 0.55]`, `violations: []`.

  Neither solution dominates the other by loss, so both are in the trade-off table.
- `REPORT`: `{ id: 'job-1', gatewayEvaluation: { termination: 'FEASIBLE', solutions: [] }, remote: { engine:
  'demo-solver', divergence: { agrees: true, notes: ['Solved with presolve'] } }, provenance: {} }`.

## 6. Requirements and tracing

| Requirement | Slice | Tests |
|---|---|---|
| `run-result-order`, `run-result-verdict`, `run-result-solution-choice`, `run-result-canonical-shape`, `run-result-names`, `run-result-without-problem`, `run-result-trade-offs`, `run-result-claimed-values`, `run-result-source`, `run-result-log` | J | `components/rendering/RunResult.test.tsx`, `runResultModel.test.ts` |
| `job-run-result` | J | `pages/Jobs/JobDetail.test.tsx`, `e2e/s6a-jobs.spec.ts` |
| `workbench-run-result` | W | `pages/Workbench/Workbench.test.tsx`, `e2e/s5d-workbench.spec.ts` |
| `engine-report-view-retired` | H | `components/EngineReportView/EngineReportView.test.tsx` |
| `check-result-diagnostic-text` | H | `pages/Workbench/CheckResult.test.tsx` (new) |
| `run-result-allow-list` | H, J, W (final state after W) | `test/rawRenderingHygiene.test.ts` |

All ids are `req~frontend-rendering-<name>~1`. The code carries `[impl->…]` next to the function that meets the
requirement, and the tests carry `[utest->…]`. The allow-list requirement is met only when W merges. H and J
assert their intermediate ceilings (10, then 9) in the same test, which W then rewrites to the final state.

## 7. Risks

- R-a: until J, real runs probably show no figures (F12). J's ui-qa compares a preview run with the fixtures. A real
  solution with neither `features` nor `metrics` shows no `Quality of this combination` list, and nothing is invented.
- Two GETs per completed job view. The compiled form can be large (tens of MiB for a big problem), and it is parsed in
  the browser. Mitigation: one request per mounted page and per job, none for unfinished jobs. A cache is out of scope.
- `readBindingProblem` is tolerant: a part it cannot read is left out, so names fall back to ids for that part, with
  no note. The note covers only the case where nothing could be read.
- Infeasible runs now show the best attempt's binding under an `INFEASIBLE` badge. ui-qa checks that it does not read
  as a valid answer (the card comes first and the bounds say `violated`).
- Shared files: the allow-list, the hygiene test and `docs/qa/RENDERING_CATALOGUE.md` have one writer at a time,
  H → J → W. The M2.4 sponsorship slice owns the two hygiene files until it merges and does not change entries 1 to 4
  (intake). If it lowers the ceiling for an entry of its own, the final numbers in the spec shift by that entry. The
  requirement (no entry 1 to 4, ceiling equal to the entry count) does not change.
- Size: J is the largest slice (the component and model, about 170 lines, plus the page changes). If its non-test diff
  goes over 300 lines, the coordinator splits it into J.1 (the component) and J.2 (the Jobs wiring) (tasks.md).
- Recharts in jsdom: `ResponsiveContainer` has no size, so `RunResult` tests check the `Trade-off set` region and its
  table, not the drawing (intake R-d). ui-qa (1440×900 and 390×844) and the e2e screenshots cover the drawing.
- Engine text: `report.remote` reaches the screen only as `SourceView` text, and notes only through `EvaluationDiff`'s
  text path.
- Archive order (intake R-f): archive `m21-rendering-catalogue` first, then the other M2.3 changes, then this one. This
  change only ADDs.

## 8. Rollback

Each slice is reverted on its own, in reverse order (W, J, H). Reverting W restores the `RunPanel` dumps and entry 3.
Reverting J restores the old Jobs result and entry 2, and removes `RunResult`. Reverting H restores the dead function
and entries 1 and 4. No API, data or dependency changes, so no migration is involved.
