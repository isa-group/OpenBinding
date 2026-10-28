# Tasks: m23-run-result

The remaining M2.3 work (`docs/agent-work/m23-run-result/handoff.md`, slices H1, J1 and W1). There are three
implementation slices, each with one PR, merged in this order: **H → J → W**. They are serial because each one writes
the two hygiene files and `docs/qa/RENDERING_CATALOGUE.md`. The tests-first task of the next slice may start while the
previous PR is open, as long as it does not write a shared file. Every slice has a tests-first task (G3) and then an
implementation task. Tests carry `[utest->req~frontend-rendering-<name>~1]`, and the code carries `[impl->…]`
(design.md §6). Paths are under `frontend/src/` unless stated otherwise. The limit is 300 non-test lines per slice.

Checks each slice registers. They are `bash -c 'set -euo pipefail; cd frontend; …'` argvs, in the forms of the
handoff's §Checks:
- FI: `pnpm install --frozen-lockfile`, first.
- VALL: the whole vitest run, with its output in `$TMPDIR` (handoff VALL, timeout 900).
- LINT: `pnpm exec eslint .`. TSC: `pnpm exec tsc -b`.
- RED (G3), `red_before`: FI, then the vitest run of the slice's tests, with an overlay of the tests and, where a
  module is new, a stub with the final exports that renders `null`. `expect_exit [1]`, `expect_pattern`
  `AssertionError|TestingLibraryElementError`, `reject_pattern`
  `Failed to resolve import|Cannot find module|Transform failed|SyntaxError` (intake F16).
- E2E: `pnpm exec playwright test --project=mocked <specs> --reporter=line`, timeout 900. If the lab has no
  browser, CI is the evidence (intake F16).
- G1: `["openspec", "validate", "m23-run-result", "--strict"]`. It is not registered for the spec task, so it is NOT
  EXECUTED until the lab or CI runs it.

## 0. Spec
- [x] 0.1 proposal.md, design.md, this file, and the `frontend-rendering` delta with 15 ADDED requirements and their
  scenarios.
- [ ] 0.2 G1, then G2 (epic review).

## 1. Slice H: retire offenders 1 and 4 (after 0.2; allow-list writes after the M2.4 sponsorship slice merges)
Owned: `components/EngineReportView/EngineReportView.{tsx,css,test.tsx}`, `pages/Workbench/CheckResult.tsx`,
`pages/Workbench/CheckResult.test.tsx` (new), `test/rawRenderingAllowList.ts`, `test/rawRenderingHygiene.test.ts`,
`docs/qa/RENDERING_CATALOGUE.md`, `docs/agent-work/m23-run-result/**`. Budget: about 140 deleted and 10 added
non-test lines. Requirements: `engine-report-view-retired`, `check-result-diagnostic-text`, `run-result-allow-list`
(intermediate).
- [ ] 1.1 Tests first. `EngineReportView.test.tsx`: the module exports exactly `RegistrationReportView`, and the
  stylesheet has none of the retired selectors (it is read through `?raw` or `fs`, like `hygiene.test.ts`). The
  existing cases stay. `CheckResult.test.tsx`: the four scenarios of `check-result-diagnostic-text`, with
  `workbenchTestKit.tsx` read as it is (H does not own it).
- [ ] 1.2 RED (G3) on the two test files. No stub is needed: both modules exist, so the new cases fail by assertion.
- [ ] 1.3 Implementation (design.md §3 H). Delete `EngineReportView` and its CSS rules, and add `textOf` in
  `CheckResult.tsx`. Delete entries 1 and 4 and set `MAX_ALLOWED_OFFENDERS = 10`. Update `rawRenderingHygiene.test.ts`
  :361-366 (ceiling 10), :382-387 (`[2, 3, 6, 8, 9, 10, 12, 13, 14, 15]`) and :401-408 (2 and 3 say `M2.3`; 1 and 4
  are absent). In `RENDERING_CATALOGUE.md`, update the M2.3 row of the offenders table and the counts in the intro and
  the hygiene section.
- [ ] 1.4 FI, VALL, LINT, TSC, and E2E on `e2e/s5d-workbench.spec.ts e2e/s8a-engines.spec.ts`.
- [ ] 1.5 Review (G11): reviewer and test-reviewer.

## 2. Slice J: the Jobs run result (tests after 0.2; implementation after H merges)
Owned: `components/rendering/{RunResult.tsx,RunResult.css,RunResult.test.tsx,runResultModel.ts,runResultModel.test.ts}`
(new), `pages/Jobs/{JobResult.tsx,useRunProblem.ts,JobDetail.tsx,Jobs.css,JobDetail.test.tsx,jobsModel.ts,jobsModel.test.ts}`,
`api/jobs.ts` (the `JobSolution` type only), `test/fixtures/jobs.ts`, `frontend/e2e/s6a-jobs.spec.ts`, the two hygiene
files, `docs/qa/RENDERING_CATALOGUE.md` and `docs/agent-work/m23-run-result/**`. Budget: about 230 added and 150
deleted non-test lines. Requirements: the ten `run-result-*` requirements other than `run-result-allow-list`, plus
`job-run-result` and `run-result-allow-list` (intermediate).
- [ ] 2.1 Tests first. `RunResult.test.tsx` and `runResultModel.test.ts` cover every scenario of the ten `run-result-*`
  requirements, with the fixtures of design.md §5. `JobDetail.test.tsx` covers the scenarios of `job-run-result`, and
  rewrites today's :85-98 (figures, `Chosen providers`, `Solution 1 source` hidden) and :163-172 (engine report). Add
  the fixtures to `test/fixtures/jobs.ts`. The stub is `RunResult.tsx` and `runResultModel.ts` with their final
  exports, rendering `null` and returning empty values.
- [ ] 2.2 RED (G3) on those three test files, overlaying the tests, the fixtures and the stub.
- [ ] 2.3 Implementation: `RunResult` and its model (design.md §2), then the Jobs wiring and `useRunProblem`
  (design.md §3 J). Update the `JobSolution` type, and drop `bindingRows`, `metricEntries`, `scoreText` and their tests,
  plus the unused `.job-figures`/`.job-binding` rules. Delete entry 2 and set the ceiling to 9. In the hygiene test,
  the ceiling is 9 and the list is `[3, 6, 8, 9, 10, 12, 13, 14, 15]`, and offender 3 says `M2.3`. In `RENDERING_CATALOGUE.md`, add a
  `RunResult` section (props, order, example), document the six components with their "Used in" (Jobs run result),
  replace the `VerdictBadge` line 110 note with the seven known verdicts, and update the offenders table.
- [ ] 2.4 FI, VALL, LINT, TSC, and E2E on `e2e/s6a-jobs.spec.ts e2e/qa-gallery.spec.ts` (update `s6a-jobs.spec.ts`
  :392-421).
- [ ] 2.5 `docs/agent-work/m23-run-result/review/how-to-test.md`: a completed job, an infeasible job, and a job whose
  compiled form is gone. ui-qa at 1440×900 and 390×844 on the preview, including R-a: a real run shows the
  `Quality of this combination` figures.
- [ ] 2.6 Review (G11): reviewer, test-reviewer and ui-qa.
- If the non-test diff goes over 300 lines, the coordinator splits J into J.1 (`RunResult`, its model and its tests,
  with no page change and no allow-list change) and J.2 (the Jobs wiring, entry 2 and the ceiling of 9).

## 3. Slice W: the workbench run result (tests with J's implementation; implementation after J merges)
Owned: `pages/Workbench/{RunPanel.tsx,Workbench.css,Workbench.test.tsx,workbenchTestKit.tsx}`,
`frontend/e2e/s5d-workbench.spec.ts`, the two hygiene files, `docs/qa/RENDERING_CATALOGUE.md`, `ROADMAP.md` (the M2.3
slice status only) and `docs/agent-work/m23-run-result/**`. Budget: about 20 added and 60 deleted non-test lines.
Requirements: `workbench-run-result` and `run-result-allow-list` (final).
- [ ] 3.1 Tests first. `Workbench.test.tsx` covers the scenarios of `workbench-run-result` and rewrites today's
  :612-622 (cells, `.wb-result-summary`, the region `Solution 1` holding `latency10`). `workbenchTestKit.tsx` mocks
  `jobsApi.ir`. The hygiene test asserts the final state: the list is `[6, 8, 9, 10, 12, 13, 14, 15]`, the ceiling is
  8, and offenders 1 to 4 are absent.
- [ ] 3.2 RED (G3) on `Workbench.test.tsx` and `rawRenderingHygiene.test.ts`. No stub is needed, because `RunResult`
  exists after J.
- [ ] 3.3 Implementation (design.md §3 W). Delete `DecisionView`, `Metrics` and `Solution` and their
  `.wb-decision*`/`.wb-metrics`/`.wb-result-summary` rules. Delete entry 3 and set `MAX_ALLOWED_OFFENDERS = 8`. In
  `RENDERING_CATALOGUE.md`, note the workbench reuse of `RunResult` and remove the M2.3 row of the offenders table. In
  `ROADMAP.md`, record M2.3 as merged once this PR merges (the coordinator may keep that line).
- [ ] 3.4 FI, VALL, LINT, TSC, and E2E on `e2e/s5d-workbench.spec.ts e2e/qa-gallery.spec.ts`.
- [ ] 3.5 Update the how-to-test guide with the workbench run. Run ui-qa at 1440×900 and 390×844.
- [ ] 3.6 Review (G11): reviewer, test-reviewer and ui-qa. **M2.3's acceptance is met when W merges.**

## Archive (later)
- [ ] After `m21-rendering-catalogue` and the six component changes are archived, archive this change in the same
  explicit archive task: `["openspec", "archive", "m23-run-result", "--yes"]`, then
  `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- `api/client.ts:353-368`: `EngineReport` and `EngineDivergence` are unused after H. Delete them in a slice that owns
  `api/client.ts` (shared with M4.4).
- `components/BindingAnalysis/BindingAnalysis.tsx:10` still names the retired "Binding decision workspace" (intake F8).
- CRP-M23-1 (intake §3): the owner's answer decides C1 and J2, which pass `claimed` and `downgrades` to
  `EvaluationDiff` through `RunResult`.
- M9.3: move `readBindingProblem` out of `pages/Cases/` so that `RunResult` can take the compiled document itself.
