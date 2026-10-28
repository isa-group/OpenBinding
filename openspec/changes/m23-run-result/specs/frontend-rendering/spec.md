## ADDED Requirements

### Requirement: Run result composition order
THE `RunResult` component SHALL render one region named `Run result` holding, in document order, the verdict, the summary line, the page notice, the solution choice or the no-binding text, the shown solution's quality figures, `BindingTable`, `QoSAgainstBounds` and `ObjectiveBreakdown`, then `EvaluationDiff`, `TradeOffChart`, the page extras, the closed `View source` disclosure and the closed engine log, each part present only under the condition design.md §2 gives for it.

`req~frontend-rendering-run-result-order~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`; `frontend/src/components/rendering/RunResult.tsx`

The fixtures `RESULT`, `PROBLEM`, `CONSTRAINTS` and `REPORT` used below are defined in design.md §5. `RESULT` is a
`FEASIBLE` run with two solutions over the criteria `cost` and `latency` and an engine log of two lines.

#### Scenario: Full run in order
- **GIVEN** `<RunResult result={RESULT} problem={PROBLEM} constraints={CONSTRAINTS} report={REPORT} notice={<p>Notice</p>}>{<p>Extras</p>}</RunResult>`
- **WHEN** it is rendered
- **THEN** inside the region named `Run result` these appear in document order: the badge `FEASIBLE`, the text `2 solutions · optimization MULTI`, the text `Notice`, the select named `Show solution`, the list named `Quality of this combination`, the region named `Chosen providers`, the region named `QoS against bounds`, the region named `Objective breakdown`, the region named `Claimed and evaluated values`, the region named `Trade-off set`, the text `Extras`, a `details` element whose summary is `View source`, and a `details` element whose summary starts with `Engine log`
- **AND** both `details` elements are closed

#### Scenario: A run without solutions
- **GIVEN** `RESULT` with `solutions: []` and no `logs`, rendered with `PROBLEM` and `CONSTRAINTS`
- **WHEN** it is rendered
- **THEN** the region shows the badge `FEASIBLE`, the text `0 solutions` and the text `This run finished without producing a binding.`
- **AND** it shows the region named `Claimed and evaluated values`
- **AND** there is no select named `Show solution`, no list named `Quality of this combination`, no region named `Chosen providers`, `QoS against bounds`, `Objective breakdown` or `Trade-off set`, no `View source` disclosure and no engine log

#### Scenario: A solution without figures or objectives
- **GIVEN** `RESULT` whose solution 1 has no `features`, no `metrics` and no `objectives`, and only that solution
- **WHEN** it is rendered with `PROBLEM` and `CONSTRAINTS`
- **THEN** there is no list named `Quality of this combination` and no region named `Objective breakdown`
- **AND** the regions named `Chosen providers` and `QoS against bounds` are shown

### Requirement: Run result verdict
THE `RunResult` component SHALL show the run's `termination` through `VerdictBadge` as its first element, and the verdict `UNKNOWN` when `termination` is not a non-empty string.

`req~frontend-rendering-run-result-verdict~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

#### Scenario: Each API termination
- **GIVEN** `RESULT` with `termination` set in turn to `OPTIMAL`, `FEASIBLE`, `INFEASIBLE` and `UNKNOWN`
- **WHEN** each is rendered
- **THEN** the first element of the region named `Run result` is the `VerdictBadge` whose badge text is that termination
- **AND** for `INFEASIBLE` the badge has the class `badge-error`

#### Scenario: No termination
- **GIVEN** `RESULT` with `termination` missing, then `null`, then `''`, then `7` (passed with a type cast)
- **WHEN** each is rendered
- **THEN** the badge text is `UNKNOWN`
- **AND** the visually hidden description reads `, no conclusion`

### Requirement: Run result solution choice
WHILE the run has more than one solution, THE `RunResult` component SHALL offer a select named `Show solution` with the options `Solution 1` to `Solution <n>` and show the per-solution parts (quality figures, `BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown` and the solution source) for the chosen solution only.

`req~frontend-rendering-run-result-solution-choice~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

#### Scenario: Choosing the second solution
- **GIVEN** `<RunResult result={RESULT} problem={PROBLEM} constraints={CONSTRAINTS} />`
- **WHEN** it is rendered, then the option `Solution 2` is chosen in the select named `Show solution`
- **THEN** before the choice the select has the options `Solution 1` and `Solution 2` and the list named `Quality of this combination` shows `latency` `420`
- **AND** after the choice that list shows `latency` `560`, the `View source` disclosure holds a region named `Solution 2 source` and none named `Solution 1 source`
- **AND** the region named `Claimed and evaluated values` still ends with `FEASIBLE, 2 solutions.` and the table named `Non-dominated solutions` still lists `Solution 1` and `Solution 2`

#### Scenario: One solution
- **GIVEN** `RESULT` with only its solution 1
- **WHEN** it is rendered
- **THEN** there is no select named `Show solution`
- **AND** the `View source` disclosure holds a region named `Solution 1 source`

### Requirement: Run result reads the canonical solution shape
THE `RunResult` component SHALL read a solution in the canonical shape: its figures from `features`, or from `metrics` only when `features` is not an object, and its optimization from `objectives.type` and `objectives.scalarization`, never from `objectives.mode`.

`req~frontend-rendering-run-result-canonical-shape~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`; `frontend/src/components/rendering/runResultModel.test.ts`

#### Scenario: Features win over metrics
- **GIVEN** `RESULT` whose solution 1 has `features: { latency: 420, cost: 9.5 }` and `metrics: { latency: 999, cost: 1 }`
- **WHEN** it is rendered with `PROBLEM` and `CONSTRAINTS`
- **THEN** the list named `Quality of this combination` shows `latency` `420` `ms` and `cost` `9.5` `EUR`
- **AND** the bound row of `max-latency` in the region named `QoS against bounds` shows the value `420 ms`
- **AND** the text `999` appears nowhere in the region named `Run result` outside the `View source` disclosure

#### Scenario: Metrics as the fallback
- **GIVEN** `RESULT` whose solution 1 has no `features` and `metrics: { latency: 300 }`
- **WHEN** it is rendered with `PROBLEM` and `CONSTRAINTS`
- **THEN** the list named `Quality of this combination` shows `latency` `300` `ms`
- **AND** the bound row of `max-latency` shows the value `300 ms`

#### Scenario: Type and scalarization, not mode
- **GIVEN** `RESULT` whose solutions' `objectives` carry `type: 'MULTI'`, `scalarization: 'pareto'` and `mode: 'legacy-mode'`
- **WHEN** it is rendered
- **THEN** the summary reads `2 solutions · optimization MULTI`
- **AND** the region named `Objective breakdown` shows `pareto` as its scalarization
- **AND** the text `legacy-mode` appears nowhere outside the `View source` disclosure

#### Scenario: Non-numeric figures are left out
- **GIVEN** `RESULT` whose solution 1 has `features: { latency: 'fast', cost: 9.5, region: { min: 1, max: 2 } }`
- **WHEN** it is rendered with `PROBLEM`
- **THEN** the list named `Quality of this combination` has one item, `cost` `9.5` `EUR`

### Requirement: Run result shows names, not digests
THE `RunResult` component SHALL identify tasks and candidates by the names of the compiled problem it receives, with no digest-shaped text outside the `View source` disclosure.

`req~frontend-rendering-run-result-names~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

#### Scenario: Task and candidate names
- **GIVEN** `<RunResult result={RESULT} problem={PROBLEM} constraints={CONSTRAINTS} />`
- **WHEN** it is rendered
- **THEN** the region named `Chosen providers` has a row for `Payment` whose candidate cell shows `Stripe EU` and whose provider cell shows `Stripe`
- **AND** its feature headers read `latency (ms)` and `cost (EUR)`

#### Scenario: No digest outside the source
- **GIVEN** `RESULT` with `provenance: { irDigest: 'sha256:' + 'a'.repeat(64) }` and `REPORT` whose `remote` holds `{ engineDigest: 'sha256:' + 'b'.repeat(64) }`
- **WHEN** it is rendered with `PROBLEM`, `CONSTRAINTS` and that report
- **THEN** the text of the region named `Run result`, without the `View source` disclosure, matches no 64-character hexadecimal run `[0-9a-f]{64}`

### Requirement: Run result without the compiled problem
IF the compiled problem of the run is not available (`problem` is `null`), THEN THE `RunResult` component SHALL show the text `The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.` before the solution choice and render the per-solution parts from the result alone.

`req~frontend-rendering-run-result-without-problem~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

#### Scenario: Problem not available
- **GIVEN** `<RunResult result={RESULT} problem={null} />`
- **WHEN** it is rendered
- **THEN** the text `The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.` is shown
- **AND** the region named `Chosen providers` shows the ids `t1` and `c1` and has only the columns `Task` and `Candidate`
- **AND** the region named `QoS against bounds` has no table named `Bounds`, and the violated soft rule `prefer-eu` of solution 1 is listed in the list named `Other rules`

#### Scenario: Problem still loading
- **GIVEN** `<RunResult result={RESULT} />` (no `problem` prop: the page has not loaded it yet)
- **WHEN** it is rendered
- **THEN** the text `The compiled problem of this run is not available` is not shown
- **AND** the region named `Chosen providers` shows the ids `t1` and `c1`

### Requirement: Run result trade-off set
THE `RunResult` component SHALL mount `TradeOffChart`, over the points of every solution of the run, only when the solutions share at least two objective components.

`req~frontend-rendering-run-result-trade-offs~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

#### Scenario: Two objectives
- **GIVEN** `RESULT`, whose two solutions both carry the components `cost` and `latency`
- **WHEN** it is rendered
- **THEN** a region named `Trade-off set` is shown, whose table named `Non-dominated solutions` has the column headers `Solution`, `cost` and `latency`

#### Scenario: One objective
- **GIVEN** `RESULT` whose solutions carry only the component `cost`
- **WHEN** it is rendered
- **THEN** there is no region named `Trade-off set`

#### Scenario: Objectives not shared by every solution
- **GIVEN** `RESULT` whose solution 1 carries `cost` and `latency` and solution 2 carries only `cost`
- **WHEN** it is rendered
- **THEN** there is no region named `Trade-off set`

### Requirement: Run result engine claims
THE `RunResult` component SHALL pass to `EvaluationDiff` the run's evaluated `termination` and `solutions`, the engine notes from `report.remote.divergence.notes` when that is an array, and no claimed values, so that the region says the engine's own values are not kept for the run.

`req~frontend-rendering-run-result-claimed-values~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

The engine's claimed values and the downgrade reasons are not in any API response (intake F14). Showing them needs the
owner decision CRP-M23-1, which is out of scope (proposal.md).

#### Scenario: No claim kept
- **GIVEN** `<RunResult result={RESULT} problem={PROBLEM} constraints={CONSTRAINTS} />`
- **WHEN** it is rendered
- **THEN** the region named `Claimed and evaluated values` reads `The values the engine claimed are not kept for this run. Gateway evaluation: FEASIBLE, 2 solutions.`
- **AND** it has no table named `Differences`

#### Scenario: The engine's provenance is not taken as its claim
- **GIVEN** `REPORT` whose `remote` is `{ termination: 'OPTIMAL', solutions: [{ features: { latency: 1 } }], divergence: { agrees: false, notes: ['Solved with presolve', 7] } }`
- **WHEN** `RunResult` is rendered with `RESULT` and that report
- **THEN** the region named `Claimed and evaluated values` still reads `The values the engine claimed are not kept for this run. Gateway evaluation: FEASIBLE, 2 solutions.` and has no table named `Differences`
- **AND** its list named `Engine notes` has the single item `Solved with presolve`

#### Scenario: No report
- **GIVEN** `RESULT` rendered with no `report`, then with `report={null}`
- **WHEN** each is rendered
- **THEN** there is no list named `Engine notes`

### Requirement: Run result sources
THE `RunResult` component SHALL show the chosen solution, and the engine report's `remote` object when it has at least one key, only through `SourceView` inside one `details` element, closed by default, whose summary is `View source`.

`req~frontend-rendering-run-result-source~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

#### Scenario: Solution and engine report sources
- **GIVEN** `<RunResult result={RESULT} problem={PROBLEM} constraints={CONSTRAINTS} report={REPORT} />`
- **WHEN** it is rendered
- **THEN** the `details` element summarised `View source` is not open
- **AND** it holds a region named `Solution 1 source` with a button named `Download Solution 1 source`, followed by a region named `Engine report source`
- **AND** every `<pre>` in the region named `Run result` is inside a `SourceView` or the `LogPanel` (element with the class `rendering-source` or `rendering-log`)

#### Scenario: Empty engine report
- **GIVEN** `REPORT` with `remote: {}`, then no `report`
- **WHEN** each is rendered with `RESULT`
- **THEN** the `View source` disclosure holds the region named `Solution 1 source` and no region named `Engine report source`

### Requirement: Run result engine log
WHEN the run's `logs` is a non-empty string, THE `RunResult` component SHALL show it as the last element of its region in a closed `LogPanel` titled `Engine log`.

`req~frontend-rendering-run-result-log~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/RunResult.test.tsx`

#### Scenario: Log present
- **GIVEN** `RESULT` with `logs: 'solve started\nsolve finished\n'`
- **WHEN** it is rendered
- **THEN** the last child of the region named `Run result` is a closed `details` element whose summary reads `Engine log (2 lines)`
- **AND** it has a button named `Download Engine log`

#### Scenario: No log
- **GIVEN** `RESULT` with `logs` missing, then `''`, then `{ text: 'x' }` (passed with a type cast)
- **WHEN** each is rendered
- **THEN** there is no element whose text starts with `Engine log`

### Requirement: Jobs page shows the run through RunResult
WHEN the job detail page shows a completed job, THE `ResultSection` of `pages/Jobs/JobResult.tsx` SHALL render the job's result through `RunResult`, with the compiled problem read from `GET /v1/jobs/{id}/ir` and the report read from `GET /v1/jobs/{id}/report`.

`req~frontend-rendering-job-run-result~1`

Needs: impl, utest

Evidence: `frontend/src/pages/Jobs/JobDetail.test.tsx`; `frontend/e2e/s6a-jobs.spec.ts`

The queued, running, cancelled and failed states keep their texts and make neither request (design.md §3).

#### Scenario: A completed feasible job
- **GIVEN** a completed job whose `result` is `RESULT`, `jobsApi.ir` resolving to the compiled document of `PROBLEM` and `jobsApi.report` resolving to `REPORT`
- **WHEN** the job detail page is shown
- **THEN** a region named `Run result` holds the badge `FEASIBLE` and a region named `Chosen providers` with the row `Payment`
- **AND** `jobsApi.ir` and `jobsApi.report` were each called once, with the job id
- **AND** the page has no region named `The engine’s own report` and no button named `Compare with the engine`

#### Scenario: The compiled problem cannot be read
- **GIVEN** the same job with `jobsApi.ir` rejecting with a 404, and `jobsApi.report` rejecting with a 410
- **WHEN** the page is shown
- **THEN** the region named `Run result` shows `The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.`
- **AND** no error notice is shown for the report, and there is no list named `Engine notes`

#### Scenario: An infeasible job
- **GIVEN** a completed job whose result has `termination: 'INFEASIBLE'` and one solution with a violation of `max-latency`, and an origin case
- **WHEN** the page is shown
- **THEN** the badge `INFEASIBLE` comes before the heading `Why no combination works`, which comes before the region named `QoS against bounds`
- **AND** the links `Try faster providers` and `See the rules` are shown

#### Scenario: Unfinished, cancelled and failed jobs
- **GIVEN** a job in the state `queued`, then `cancelled`, then `failed` with the error `Engine crashed`
- **WHEN** each page is shown
- **THEN** the texts are `No result yet. It appears here when the run finishes.`, `Cancelled before producing a result.` and a notice titled `The run failed` reading `Engine crashed. Retrying starts a new attempt.`
- **AND** there is no region named `Run result`, and neither `jobsApi.ir` nor `jobsApi.report` was called

#### Scenario: Single-task swaps
- **GIVEN** the completed feasible job, and `getBindingNeighborhood` resolving to a neighbourhood with one move
- **WHEN** the button `Check single swaps` is pressed
- **THEN** the region named `Run result` holds the list named `Single-task swaps` before its `View source` disclosure
- **AND** the swaps panel holds a closed `details` element summarised `View source` with a region named `Swaps source`
- **AND** `pages/Jobs/JobResult.tsx` contains no `<pre` and no rendered `JSON.stringify`

### Requirement: Workbench run panel shows the run through RunResult
WHEN the workbench holds a run result, THE `RunPanel` of `pages/Workbench/RunPanel.tsx` SHALL render it through `RunResult`, inside its `Authoritative result` region, with the compiled problem read from `GET /v1/jobs/{resultJobId}/ir`.

`req~frontend-rendering-workbench-run-result~1`

Needs: impl, utest

Evidence: `frontend/src/pages/Workbench/Workbench.test.tsx`; `frontend/e2e/s5d-workbench.spec.ts`

#### Scenario: A run result in the workbench
- **GIVEN** a workbench whose run finished with `RESULT` as job `job-1`, and `jobsApi.ir('job-1')` resolving to the compiled document of `PROBLEM`
- **WHEN** the run panel is shown
- **THEN** the region named `Authoritative result` holds a region named `Run result` with the badge `FEASIBLE` and a region named `Chosen providers` with the row `Payment`
- **AND** `jobsApi.ir` was called once, with `job-1`

#### Scenario: A decision that is not a binding
- **GIVEN** a run result whose solution 1 has `decision: { kind: 'placement', placement: { p1: 'pool-a' } }`
- **WHEN** the run panel is shown
- **THEN** the region named `Chosen providers` is absent and the text `This solution carries no binding assignment.` is shown
- **AND** the region named `Solution 1 source`, inside the closed `View source` disclosure, contains the text `pool-a`

#### Scenario: No job id or no compiled problem
- **GIVEN** a run result with no `resultJobId`, then one whose `jobsApi.ir` rejects with a 409
- **WHEN** the run panel is shown
- **THEN** the region named `Run result` shows `The compiled problem of this run is not available, so tasks and candidates are shown by id, without feature values, bounds or units.`

#### Scenario: No raw rendering left in the run panel
- **GIVEN** `frontend/src/pages/Workbench/RunPanel.tsx`
- **WHEN** the raw-rendering detector of `rawRenderingHygiene.test.ts` reads it
- **THEN** it finds no `<pre` and no rendered `JSON.stringify`

### Requirement: Dead engine report view retired
THE module `frontend/src/components/EngineReportView/EngineReportView.tsx` and its stylesheet SHALL keep only `RegistrationReportView` and its rules, with the retired `EngineReportView` function and its rules deleted.

`req~frontend-rendering-engine-report-view-retired~1`

Needs: impl, utest

Evidence: `frontend/src/components/EngineReportView/EngineReportView.test.tsx`

#### Scenario: Only the registration report is exported
- **GIVEN** the module `components/EngineReportView/EngineReportView`
- **WHEN** its exports are listed
- **THEN** they are exactly `['RegistrationReportView']`

#### Scenario: Only registration rules in the stylesheet
- **GIVEN** `frontend/src/components/EngineReportView/EngineReportView.css`
- **WHEN** it is read
- **THEN** it contains no selector with `.engine-report`, `.engine-claimed`, `.divergence-notes` or `.divergence-hint`
- **AND** it still contains `.registration-report`

#### Scenario: The registration report is unchanged
- **GIVEN** the existing `RegistrationReportView` tests of `EngineReportView.test.tsx`
- **WHEN** they run
- **THEN** they pass unchanged

### Requirement: Workbench diagnostic without a message
IF a workbench diagnostic has neither a non-empty string `message` nor a non-empty string `detail`, THEN THE diagnostic list of `pages/Workbench/CheckResult.tsx` SHALL show the text `The gateway sent no message for this diagnostic.` after its code, and never a serialisation of the diagnostic.

`req~frontend-rendering-check-result-diagnostic-text~1`

Needs: impl, utest

Evidence: `frontend/src/pages/Workbench/CheckResult.test.tsx`

#### Scenario: No message and no detail
- **GIVEN** a failed validation whose diagnostics are `[{ code: 'E_REF', pointer: '/spec/tasks/0' }]`
- **WHEN** `CheckResult` is rendered
- **THEN** the list named `Diagnostics` has one button whose text is `E_REF The gateway sent no message for this diagnostic.`
- **AND** the list contains neither `{` nor `"code"`
- **AND** `/spec/tasks/0` is shown once, as the place of the diagnostic

#### Scenario: Message, then detail
- **GIVEN** the diagnostics `[{ code: 'E1', message: 'Unknown task' }, { code: 'E2', message: '', detail: 'Missing candidate' }, { message: 'No code' }]`
- **WHEN** `CheckResult` is rendered
- **THEN** the buttons read `E1 Unknown task`, `E2 Missing candidate` and `diagnostic No code`, in that order

#### Scenario: A message that is not text
- **GIVEN** the diagnostic `{ code: 'E3', message: { en: 'x' } }`, passed with a type cast
- **WHEN** `CheckResult` is rendered
- **THEN** it does not throw, and the button reads `E3 The gateway sent no message for this diagnostic.`

#### Scenario: The diagnostic still opens its resource
- **GIVEN** the diagnostic `{ code: 'E_REF', pointer: '/spec/tasks/0' }` and a spy as `wb.openDiagnostic`
- **WHEN** its button is pressed
- **THEN** the spy was called once, with that diagnostic

### Requirement: Run result offenders off the allow-list
THE raw-rendering allow-list `frontend/src/test/rawRenderingAllowList.ts` SHALL hold no entry for the offenders 1 to 4 of ROADMAP M2, with `MAX_ALLOWED_OFFENDERS` equal to its number of entries.

`req~frontend-rendering-run-result-allow-list~1`

Needs: impl, utest

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`

#### Scenario: Offenders 1 to 4 are gone
- **GIVEN** `RAW_RENDERING_ALLOW_LIST` after the last slice of this change, with no other slice having retired an entry since `00f653ef`
- **WHEN** its offender numbers are listed
- **THEN** they are `[6, 8, 9, 10, 12, 13, 14, 15]`
- **AND** `MAX_ALLOWED_OFFENDERS` is `8`
- **AND** no entry names `components/EngineReportView/EngineReportView.tsx`, `pages/Jobs/JobResult.tsx`, `pages/Workbench/RunPanel.tsx` or `pages/Workbench/CheckResult.tsx`

#### Scenario: The hygiene test stays green
- **GIVEN** the sources of `frontend/src` after the last slice
- **WHEN** `rawRenderingHygiene.test.ts` runs
- **THEN** it reports no unlisted finding, no stale entry and no wrong line number
- **AND** `UNLISTED_FINDINGS` still holds only offender `16`
