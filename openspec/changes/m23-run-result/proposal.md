# Change: m23-run-result

## Why

ROADMAP M2.3 (owner request own-58fe9d3b57f44525a17f2ff5bde0667f, release R1): "Run result rendered (`BindingTable`,
`QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`, `LogPanel`, and `TradeOffChart` when there are several
objectives)". Acceptance: "offenders 1–4 removed from the allow-list" (`ROADMAP.md:68`). The run page of ARCHITECTURE
§5.2 shows "verdict, engine mode and budget first; then the binding table, QoS against bounds, the objective breakdown
and engine-claimed versus evaluated values; the trade-off set when there are several objectives; the log collapsed at
the bottom" (`docs/ARCHITECTURE.md:225-227`). The M2 goal includes "names instead of digests" (`ROADMAP.md:61-62`).

The six components are merged in `frontend/src/components/rendering/` (slices B1, Q1, O1, T1, E1 and V1 of
`docs/agent-work/m23-run-result/handoff.md`), but no page uses them. The four offenders still dump data
(`frontend/src/test/rawRenderingAllowList.ts:29-71`, ceiling 12 at :24). Offender 1 is a dead function, offender 4 is a
fallback string, and offenders 2 and 3 are the run result on the Jobs page and in the workbench (intake F6-F9). The
pages also read `metrics` and `objectives.mode`, where the canonical solution has `features` and
`objectives.type`/`scalarization` (intake F12). This change is the remaining M2.3 work: the handoff's slices H1, J1
and W1, written as one change with three slices.

## What Changes

- The dead `EngineReportView` function and its styles are deleted, and `RegistrationReportView` stays. A workbench
  diagnostic without a message reads `The gateway sent no message for this diagnostic.` instead of its JSON.
- A new catalogue composition, `RunResult` (`frontend/src/components/rendering/RunResult.tsx`), shows one run in the
  §5.2 order: the verdict, then the shown solution's quality figures, `BindingTable`, `QoSAgainstBounds` and
  `ObjectiveBreakdown`, then `EvaluationDiff`, `TradeOffChart` when the solutions share at least two objectives, the
  solution source in `SourceView` inside a closed `View source` disclosure, and the engine log in a closed `LogPanel`.
- The run result reads `features` first and `metrics` only as a fallback, and `objectives.type`/`scalarization`
  instead of `mode`. Tasks and candidates are named from the compiled problem of the run
  (`GET /v1/jobs/{id}/ir`), and no digest is shown outside the source disclosure.
- Without the engine's claimed values (none are in the API today), `EvaluationDiff` says that the engine's own values
  are not kept for this run. Engine notes from the report are shown as text.
- The Jobs page and the workbench run panel render their results through `RunResult`. The "Compare with the engine"
  card, the local `<pre>` blocks and the `JSON.stringify` dumps are gone.
- Offenders 1 to 4 leave the hygiene allow-list, and `MAX_ALLOWED_OFFENDERS` goes from 12 to 8 (10 after H, 9 after
  J, 8 after W). `docs/qa/RENDERING_CATALOGUE.md` documents `RunResult` and where each of the six components is wired.

## Impact

- Capability `frontend-rendering`: 15 ADDED requirements `req~frontend-rendering-<name>~1` (design.md §6). They are
  ADDED and not MODIFIED because the capability lives only in the unarchived change `m21-rendering-catalogue`, and a
  MODIFIED delta needs a living spec (intake R-f).
- Code, in `frontend/src/` unless stated otherwise (tasks.md lists the owned files per slice):
  - `components/EngineReportView/`, `pages/Workbench/CheckResult.tsx` (H);
  - `components/rendering/RunResult.*` and `runResultModel.*` (new), `pages/Jobs/` (`JobResult.tsx`,
    `useRunProblem.ts` new, `jobsModel.ts`, `Jobs.css`, tests), `api/jobs.ts` (the `JobSolution` type only),
    `test/fixtures/jobs.ts` and `frontend/e2e/s6a-jobs.spec.ts` (J);
  - `pages/Workbench/RunPanel.tsx`, `Workbench.css`, `Workbench.test.tsx`, `workbenchTestKit.tsx` and
    `frontend/e2e/s5d-workbench.spec.ts` (W);
  - `test/rawRenderingAllowList.ts`, `test/rawRenderingHygiene.test.ts` and `docs/qa/RENDERING_CATALOGUE.md` (H, then
    J, then W, one writer at a time).
- API: none. The pages call two existing owner-only GETs (`/v1/jobs/{id}/ir` and `/v1/jobs/{id}/report`). There is
  no OpenAPI, gateway, bim-core or dependency change. Recharts is already a dependency (intake F5).
- Risk: medium (R9, `frontend/src/**/*.tsx`, `*.css`, `frontend/e2e/**`). Each slice is reviewed by reviewer and
  test-reviewer, and J and W also by ui-qa at 1440×900 and 390×844. The risks are in design.md §7. The main ones are the
  empty figures on real runs (R-a, fixed here and confirmed on a preview), the size of slice J, and the hygiene files,
  which are shared with the M2.4 sponsorship slice.
- G1: no check is registered for this task, so `openspec validate m23-run-result --strict` is NOT EXECUTED here. The
  layout copies the merged `m23-*` and `m21-rendering-catalogue` changes.

## Out of scope

- CRP-M23-1: exposing the engine's claimed values and the downgrade reasons (`engineClaimed`, `downgrades` on
  `GET /v1/jobs/{id}/report`), and the slices C1 and J2 that would follow it. That is an owner decision with a
  public API change. `EvaluationDiff` already accepts `claimed` and `downgrades` for later.
- Engine mode and budget in the run header (ARCHITECTURE §5.2). They stay in the job page header as today.
- The workbench `BindingAnalysis` stub, the now-unused `EngineReport`/`EngineDivergence` types in `api/client.ts`
  (shared with M4.4), and moving `readBindingProblem` out of `pages/` (M9.3). These are followups in tasks.md.
- Changes to the six components, to `VerdictBadge` or to the M2.1 catalogue. The other offenders (M2.5, M2.6), digest
  detection (M2.7), `openspec/specs/**` and archiving.
