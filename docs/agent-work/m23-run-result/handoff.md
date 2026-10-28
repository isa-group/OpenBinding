# Handoff: m23-run-result
- Status: waiting-review (plan for the coordinator; CRP-M23-1 for the owner) · Updated: 2026-10-27T12:00:00Z
- Branch / head: task branch on 00f653ef · PR: none (planning only)

## Goal
Slice ROADMAP M2.3 (owner request own-58fe9d3b57f44525a17f2ff5bde0667f, release R1) into changes of one capability
each. The changes have disjoint owned files, are written tests first, and end with offenders 1 to 4 off the hygiene
allow-list. The facts, with file:line references, are F1-F18 in [intake.md](intake.md).

## State (with evidence)
- Nothing is built. None of the five new components exists (F3). Offenders 1 to 4 are listed at
  `frontend/src/test/rawRenderingAllowList.ts:29-71`, with the ceiling at 12 (:24).
- Offender 1 is dead code (F6). Offender 4 is a fallback string (F9). The claimed values are not in the API (F14).
  The frontend reads `metrics` and `mode` where the canonical solution has `features` and `type`/`scalarization` (F12).
- No check was run: this task has no registered check, and its output is these two documents.

## Decisions (planner; the coordinator may override)
- Each new component goes in its own files: `components/rendering/<Name>.tsx`, `.css` (tokens only) and `.test.tsx`,
  plus `<name>Model.ts` for its pure derivation. A component imports nothing from `pages/` (intake §2.2).
- The page composition goes in `components/RunResult/RunResult.tsx`, created by J1 and reused by W1. Reason: Jobs and
  Workbench show one run the same way, and there is no `widgets/` until M9.3 (F18).
- The gateway's violations decide whether a rule is met. The client only positions a value against a bound (R-b).
- BindingTable shows the chosen candidate's own feature values. It does not show "contribution shares", because
  aggregation depends on the workflow and is the gateway's job (INTENT principle 3).
- Trade-offs: TradeOffChart renders when the solutions carry at least 2 objective components. Dominance uses
  `loss`, which is lower-is-better with direction already applied (F11). The axes show `value`. The chart needs at
  least 2 solutions; otherwise only the table is shown, with a note.
- Terminations: V1 adds `INFEASIBLE` and `UNKNOWN` as known verdicts to `VerdictBadge`, as an ADDED requirement
  (R-f).
- H1 groups offenders 1 and 4. Reason: one capability (the ratchet shrinks with no new UI), under 60 non-test
  lines, and one writer of the allow-list less. The coordinator may split it.

## Slices
Defaults apply (model, effort), and the size limit is ≤300 non-test lines. "Spec" is a specifier task writing
`openspec/changes/<change>/**` (proposal, design, tasks, a `frontend-rendering` delta with ADDED
`req~frontend-rendering-<name>~1`). Every slice then runs: tests-first task (with a stub, G3) → implementation task.
Every slice also owns `docs/agent-work/<change>/**` (its how-to-test guide).

| Id | Change · turns (spec/tests/impl) | Risk (why) | Owns, exclusive while running | Starts |
|---|---|---|---|---|
| H1 | m23-retire-dead-and-fallback · 25/30/40 | medium (R9; deletion and a text fallback) | `components/EngineReportView/EngineReportView.{tsx,css,test.tsx}`, `pages/Workbench/CheckResult.tsx`, `pages/Workbench/CheckResult.test.tsx` (new), `test/rawRenderingAllowList.ts`, `test/rawRenderingHygiene.test.ts`, `docs/qa/RENDERING_CATALOGUE.md`, `ROADMAP.md` (M2 row and M2.3 status only) | **now** (allow-list writes after M2.4 slice 5 merges) |
| B1 | m23-binding-table · 25/30/50 | medium (R9, new UI) | `components/rendering/{BindingTable.tsx,BindingTable.css,BindingTable.test.tsx,bindingTableModel.ts,bindingTableModel.test.ts}` | **now** |
| Q1 | m23-qos-against-bounds · 30/35/60 | medium (R9; expression reading) | `components/rendering/{QoSAgainstBounds.*,qosBoundsModel.ts,qosBoundsModel.test.ts}` | **now** |
| O1 | m23-objective-breakdown · 25/30/45 | medium (R9) | `components/rendering/{ObjectiveBreakdown.*,objectiveModel.ts,objectiveModel.test.ts}` | **now** |
| T1 | m23-trade-off-chart · 30/35/60 | medium (R9, chart and a11y) | `components/rendering/{TradeOffChart.*,tradeOffModel.ts,tradeOffModel.test.ts}` | **now** |
| E1 | m23-evaluation-diff · 25/30/50 | medium, external input (engine text) | `components/rendering/{EvaluationDiff.*,evaluationDiffModel.ts,evaluationDiffModel.test.ts}` | **now** |
| V1 | m23-verdict-terminations · 15/20/25 | low-medium (R9, 2 entries) | `components/rendering/VerdictBadge.{tsx,css,test.tsx}` | **now** |
| J1 | m23-job-run-result · 30/40/70 | medium (R9; >200 lines, 2 modules) | `pages/Jobs/{JobResult.tsx,JobDetail.tsx,Jobs.css,JobDetail.test.tsx,jobsModel.ts,jobsModel.test.ts}`, `api/jobs.ts` (the `JobSolution` type only), `test/fixtures/jobs.ts`, `components/RunResult/**`, `e2e/s6a-jobs.spec.ts`, the two hygiene files, `RENDERING_CATALOGUE.md`, `ROADMAP.md` | spec+tests: when the B1-V1 specs pass G1. Impl: after B1-V1 and H1 merge |
| W1 | m23-workbench-run-result · 25/35/50 | medium (R9) | `pages/Workbench/{RunPanel.tsx,Workbench.css,Workbench.test.tsx,workbenchTestKit.tsx}`, `e2e/s5d-workbench.spec.ts`, the two hygiene files, `RENDERING_CATALOGUE.md`, `ROADMAP.md` | spec+tests: with J1's impl. Impl: after J1 merges |
| C1 | m23-report-engine-claims · 40/40/70 | **high** (R3 public API +3, external input +2, 2 modules +1) | `openspec/changes/m23-report-engine-claims/**`, `…/routes/v1.py` (the `job_report` handler only), `…/main.py` (the `JobReport` schema only), `docs/openapi.json` (regenerated), `openbinding-gateway/tests/test_job_report_claims.py` (new) | after CRP-M23-1 = A; in parallel with everything else |
| J2 | m23-job-engine-claims · 15/25/35 | medium | `components/RunResult/**`, `pages/Jobs/JobDetail.test.tsx`, `api/jobs.ts` (`JobReport` type) | after C1 and J1 |

All paths are under `frontend/src/` unless they start with `frontend/e2e`, `docs/`, `ROADMAP.md` or
`openbinding-gateway`; `…/` stands for `openbinding-gateway/src/openbinding_gateway/`. **Parallel now: H1, B1, Q1, O1,
T1, E1 and V1** (pairwise disjoint). Serial: H1 → J1 → W1 for the hygiene files, `ROADMAP.md` and
`RENDERING_CATALOGUE.md`. Each lowers `MAX_ALLOWED_OFFENDERS` (12 → 10 → 9 → 8) and updates
`rawRenderingHygiene.test.ts:361-366`, `:382-387` and `:401-408`. **M2.3's acceptance is met when W1 merges.** C1
is not on that path. Each slice that wires a component documents it in `RENDERING_CATALOGUE.md`: J1 covers all six
components, and W1 notes its reuse.

### Prop contracts (pin them in each slice's design.md; J1 relies on them)
Inputs are structural (declared in the model file), and the solution shape is canonical (F11): `features ?? metrics`,
`objectives.{type, scalarization, components, penalty, score}`.
- `BindingTable({ rows, features?, label = 'Chosen providers' })`. A row is `{ task, taskName, candidate, candidateName,
  provider: string|null, values: Record<feature, number|{min,max}|null> }`. `features` sets the column order, with a
  unit per header. The table is wrapped in the `DataTable` scroll region (mobile). Model:
  `bindingRowsOf(binding, problem|null)`; without a problem it shows the columns task and candidate only.
- `QoSAgainstBounds({ bounds, rules, label = 'QoS against bounds' })`. A bound is `{ rule, feature, op, limit, value:
  number|null, unit, enforcement, met: boolean|null, penalty?: number }`, and a rule is `{ rule, text, when:
  string|null, enforcement, met: boolean|null }`. `met` comes from `violations`, and the status is always text (met,
  violated, not checked). Model: `qosBoundsOf(constraints, features, violations)`.
- `ObjectiveBreakdown({ terms, penalty, score, scalarization, label = 'Objective breakdown' })`. A term is
  `{ criterion, feature, direction, value, loss, weight, weighted: loss×weight }`. A list score shows one value per
  term. Model: `objectiveTermsOf(objectives, problem|null)`.
- `TradeOffChart({ points, objectives, label = 'Trade-off set' })`. A point is `{ id, label, values:
  Record<criterion, number>, losses: Record<criterion, number> }`. It shows a table of the non-dominated points and
  a Recharts scatter, with two `select` controls named "Horizontal axis" and "Vertical axis" over `objectives`. The
  chart has `role="img"` with a text summary. Model: `nonDominated(points)` and `tradeOffPointsOf(solutions)`.
- `EvaluationDiff({ evaluated, claimed?, notes?, downgrades? })`. `evaluated` and `claimed` are `{ termination,
  solutions: Array<{ features, score }> }`. It renders "agrees" in one line and spells out differences per feature.
  Without `claimed`, it says the engine's own values are not kept for this run. Engine strings render as text only.
  Model: `evaluationDiffOf(evaluated, claimed?)`.
- `VerdictBadge`: adds `INFEASIBLE` (error: "no combination meets the rules") and `UNKNOWN` (default: "no
  conclusion"). The exact words come from the V1 spec, with `jobsModel.ts:47-55` as the vocabulary source.
- `RunResult({ result, problem|null, jobId?, report? })` (J1) shows, in order: the verdict, then BindingTable,
  QoSAgainstBounds, ObjectiveBreakdown, EvaluationDiff, TradeOffChart (when there are ≥2 objectives), the
  per-solution `SourceView` inside a closed "View source" disclosure, and `LogPanel` (`result.logs`, closed) last.

### What each page slice delivers
- **H1**: delete `EngineReportView` and its `.engine-report*` CSS, keeping `RegistrationReportView`. `CheckResult.tsx:58`
  falls back to text (`message || detail || "The gateway sent no message for this diagnostic."`, plus the pointer when
  present) and never stringifies. Entries 1 and 4 leave the allow-list, and the ceiling goes to 10.
  `api/client.ts:353-368` (now unused types) is left to M9.3 (followup).
- **J1**: `ResultSection` keeps its states (queued, failed, cancelled, infeasible). The figures and the table become
  `RunResult`, with `problem` loaded lazily from `jobsApi.ir(jobId)`. The local `SourceView` and the log `<pre>` are
  gone, so are entry 2 and the swaps-panel dump (to `SourceView`), and the ceiling goes to 9. The fixtures move to the
  canonical shape, with a compiled problem fixture of 3 tasks, 2 criteria, one hard `features.latency ≤ 600` and one
  soft rule. A preview run checks R-a.
- **W1**: the solutions render through `RunResult`. `problem` comes from `wb.compiledIr`, or else from
  `jobsApi.ir(wb.resultJobId)`. The decision fallback goes to `SourceView`, entry 3 leaves the list and the ceiling
  goes to 8. The `BindingAnalysis` stub stays (followup).

## Checks (proposed argv; register per slice)
- FI: `["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile"]`, run first in every frontend slice.
- V(f…): `["bash","-c","set -euo pipefail; cd frontend; pnpm exec vitest run <f…>"]`.
- VALL: `["bash","-c","set -euo pipefail; cd frontend; pnpm exec vitest run > \"$TMPDIR/v.txt\" 2>&1 || { tail -n 200 \"$TMPDIR/v.txt\"; exit 1; }; tail -n 30 \"$TMPDIR/v.txt\""]`, timeout 900.
- LINT: `["bash","-c","set -euo pipefail; cd frontend; pnpm exec eslint ."]`. TSC: `["bash","-c","set -euo pipefail; cd frontend; pnpm exec tsc -b"]` (noEmit, so it writes nothing to the worktree).
- RED(f…): `{"argv":["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run <f…>"],"type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError|TestingLibraryElementError","reject_pattern":"Failed to resolve import|Cannot find module|Transform failed|SyntaxError","overlay":["<tests>","<stub>"]}`, with gate G3.
- E2E(s…): `["bash","-c","set -euo pipefail; cd frontend; pnpm exec playwright test --project=mocked <s…> --reporter=line"]`, timeout 900. If the lab has no browser, CI is the evidence.
- G1(c): `["openspec","validate","<c>","--strict"]`. Reported NOT EXECUTED if the lab lacks the CLI (F16).
- Gateway, C1 only: S, ALL, RUFF and OAPI exactly as in `docs/agent-work/m4-plans-slices/handoff.md:99-110`, plus the
  write run `["uv","run","--directory","openbinding-gateway","--locked","python","tools/dump_openapi.py"]` before OAPI,
  and P(`tests/test_job_report_claims.py`,`tests/test_openapi_contract.py`).

Per slice:
- Spec tasks run G1 of their change, then G2 (epic review).
- Tests-first tasks run FI and RED (tests and stub), with gate G3.
- B1, Q1, O1, T1, E1 and V1 run FI, V(their tests, `src/test`), LINT and TSC.
- H1, J1 and W1 run FI, VALL, LINT, TSC and E2E. H1 runs E2E on `e2e/s5d-workbench.spec.ts e2e/s8a-engines.spec.ts`,
  J1 on `e2e/s6a-jobs.spec.ts e2e/qa-gallery.spec.ts`, and W1 on `e2e/s5d-workbench.spec.ts e2e/qa-gallery.spec.ts`.
- The coordinator's last commit runs `["python3","tools/generate_changelog.py","--check"]` after regeneration.

Review panels (`.agentic/project.yaml:141-147`): reviewer and test-reviewer for every slice, plus security-auditor for
E1; ui-qa (1440×900 and 390×844) for B1, Q1, O1, T1, E1, J1 and W1; the high panel for C1, whose OpenAPI delta is
reviewed before any code (factory:openapi-contracts).

## Ruled out
- Mapping the workbench diagnostics onto `DiagnosticsList`: there is no severity field, and the open-in-editor buttons
  would be lost (F9).
- One umbrella PR for M2.3: over 1,000 lines across R9 files, with no parallelism.
- Splitting the allow-list per offender so that the page slices could run in parallel: that changes the M2.2 ratchet
  design for one milestone.
- Deriving claimed values from `remote` (the engine's provenance): it is not the claim (F14).

## Open questions and risks
- CRP-M23-1 (intake §3): waiting on the owner. The recommendation is A, scheduled after W1, not gating R1.
- Risks R-a to R-g are in intake §4. The most important is R-a: the figures may be empty on real runs today.

## Next three steps
1. Coordinator: open the specifier tasks of H1, B1, Q1, O1, T1, E1 and V1 now, with the owned globs above and G1. They
   are pairwise disjoint, so cap them to the lab's gate capacity.
2. Coordinator: send CRP-M23-1 to the owner with option A recommended.
3. As each spec passes G1 and G2, open its tests-first task (RED with a stub, G3), then its implementation task. Open
   J1's spec and tests when the B1-V1 specs pass, J1's implementation when B1-V1 and H1 merge, then W1 in the same
   way. Archive m21 and then all m23 changes in one explicit archive task (owner-held `openspec/specs/**`).

## Evidence
- Planning task on 00f653ef; no lookups (every fact is in the repository, intake F1-F18); no check registered or run.
