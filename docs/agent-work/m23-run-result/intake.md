# Intake: m23-run-result (ROADMAP M2.3)

- Owner request: own-58fe9d3b57f44525a17f2ff5bde0667f. Render the run result with the M2.1 catalogue plus
  `BindingTable`, `QoSAgainstBounds`, `ObjectiveBreakdown`, `EvaluationDiff`, `LogPanel`, and `TradeOffChart` when
  there are several objectives. Acceptance: offenders 1 to 4 (EngineReportView, Jobs/JobResult, Workbench/RunPanel,
  Workbench/CheckResult) removed from the hygiene allow-list. Part of release R1. The owner wants it as soon as
  possible.
- Written: 2026-10-27, at worktree head `00f653ef`. The planner writes only `docs/agent-work/m23-run-result/**`.
  Slices, contracts, checks and order are in [handoff.md](handoff.md).
- Out of scope: the M2.4 sponsorship slice still under review. It owns `rawRenderingAllowList.ts` and
  `rawRenderingHygiene.test.ts` until it merges, but does not change the M2.3 entries. Also out of scope: M2.5 to
  M2.8, `openspec/specs/**` (R11, owner-only) and `frontend/src/api/client.ts` (shared with M4.4).

## 1. Verified facts (file:line at 00f653ef)

### Roadmap, architecture, catalogue
- F1. `ROADMAP.md:68` gives the M2.3 deliverable and acceptance. `ROADMAP.md:83-86` lists offenders 1 to 4.
  `ROADMAP.md:75-79`: M2.1 and M2.2 are merged (PR #38), and M2.4 slices 1 to 4 are merged.
- F2. `docs/ARCHITECTURE.md:225-227` describes the run page. It shows the verdict, engine mode and budget first, then
  the binding table, QoS against bounds, the objective breakdown and engine-claimed versus evaluated values, then the
  trade-off set when there are several objectives, with the log collapsed at the bottom. `:245-249` defines the five
  new components. `:262-264`: charts use Recharts, and only `SourceView` and `LogPanel` may render `<pre>` or
  `JSON.stringify` output.
- F3. The catalogue is in `frontend/src/components/rendering/`: `SourceView`, `LogPanel`, `DiagnosticsList`,
  `VerdictBadge` and `MetricCards`, plus `download.ts`. There is no `index.ts`; components are imported by path
  (`docs/qa/RENDERING_CATALOGUE.md:16`). None of the five new components exists
  (`RENDERING_CATALOGUE.md:197`, plus a search of `frontend/src`).
- F4. `VerdictBadge` knows `OPTIMAL`, `FEASIBLE`, `UNSAT`, `TIMEOUT` and `INCOMPATIBLE` (`VerdictBadge.tsx:10-16`).
  The API's terminations are `OPTIMAL | FEASIBLE | INFEASIBLE | UNKNOWN` (`openbinding-gateway/src/openbinding_gateway/main.py:987-991`).
  The M2.1 design defers the mapping to M2.3 (`openspec/changes/m21-rendering-catalogue/design.md:278-280`,
  `docs/agent-work/m21-rendering-catalogue/handoff.md:5`).
- F5. Recharts `^2.15.4` is already a dependency (`frontend/package.json:34`), used by
  `components/TraceChart/TraceChart.tsx`. TradeOffChart therefore needs no `package.json` change (R10).

### The four offenders
- F6. Offender 1: `components/EngineReportView/EngineReportView.tsx:121-202` (`EngineReportView`, with the `<pre>` blocks
  at :182, :187 and :198) has **no importer**. The only import of that file is `RegistrationReportView`
  (`pages/EngineDetail/EngineDetail.tsx:16`, `EngineReportView.test.tsx:4`). The `.engine-report*` CSS rules
  (`EngineReportView.css:1-50`) serve only the dead function. The types `EngineReport` and `EngineDivergence`
  (`api/client.ts:353-368`) are used only by the dead function.
- F7. Offender 2: `pages/Jobs/JobResult.tsx` has a local `SourceView` with a `<pre>` at :27-34. It is used for the
  solution (:103), the engine report (:154) and the swaps (:237). The engine log is a `<pre>` at :283-288. The
  binding is a table without features (:88-102), and the figures are a list read from `solution.metrics` and
  `objectives.mode` (:83-87, `jobsModel.ts:243-255`). `ResultSection` is mounted by `JobDetail.tsx:195`.
- F8. Offender 3: `pages/Workbench/RunPanel.tsx:12-31` shows a decision table, with a `<pre>` fallback at :28. A second
  `<pre>` at :52-55 dumps metrics, objectives, penalties, violations and evaluation. `wb.result` and
  `wb.resultJobId` feed it (:140-151). `BindingAnalysis` (:142) is a stub that still names the retired "Binding
  decision workspace" (`components/BindingAnalysis/BindingAnalysis.tsx:10`).
- F9. Offender 4: `pages/Workbench/CheckResult.tsx:58` falls back to `JSON.stringify(item)` in the workbench's own
  `DiagnosticList` (:43-67). It is a validation screen, not the run result. The workbench `Diagnostic` has no
  `severity` (`pages/Workbench/bimDocuments.ts:109-124`). Each item is a button that opens the resource
  (`onOpen`), and both tests and e2e depend on that list (`Workbench.test.tsx:251`, `e2e/s5d-workbench.spec.ts:379`).
- F10. Hygiene: `frontend/src/test/rawRenderingAllowList.ts:24` sets `MAX_ALLOWED_OFFENDERS = 12`, and entries 1 to 4
  are at :29-71. `rawRenderingHygiene.test.ts:276-278` fails on a stale entry, so **the slice that removes a raw line
  must delete its entry in the same PR**. The following tests pin today's list, and each retiring slice must update
  them: `:361-366` (ceiling 12), `:382-387` (exact list), `:401-408` (offenders 1 to 4 say `M2.3`).

### Data the run result can draw on
- F11. A canonical solution (bim-engine/v1) has `decision`, `features`, `objectives`, `penalties` and `violations`
  (`bim-toolchain/packages/bim-core/src/bim_core/protocol.py:55-56`). The objectives are `{type, scalarization,
  components[{criteria, feature, value, loss, weight}], penalty, score}`, and `score` is a list unless the run is SINGLE
  weighted-sum (`compiler.py:4344-4367`, `protocol.py:186-199`). A violation is `{constraint, enforcement, penalty,
  message?}` (`protocol.py:206-217`, `compiler.py:4321`). The gateway keeps these fields (`reevaluate.py:113-119`).
- F12. **Shape drift in the frontend.** `JobSolution` and the screens read `solution.metrics` and `objectives.mode`
  (`api/jobs.ts:10-17`, `jobsModel.ts:243-255`, `RunPanel.tsx:49`). The canonical field is `features`
  (`openbinding-gateway/tests/test_v1_platform_contracts.py:934`), and the gateway's own reader takes `features`
  first, then `metrics` (`v1/archive.py:567-568`). The unit fixtures use the old shape
  (`frontend/src/test/fixtures/jobs.ts:41-54`). So on a real run the figures list is probably empty. That is
  unverified in the lab, and ui-qa confirms it on a preview in J1.
- F13. The job result has no constraint bounds and no per-task values. They come from the compiled form the run
  used: `jobsApi.ir(id)` → `GET /v1/jobs/{id}/ir` (`api/jobs.ts:106`), which is already called for the download
  (`JobDetail.tsx:136`). `readBindingProblem` (`pages/Cases/bindingModel.ts:246-381`) reads from it the tasks,
  candidates with feature values, criteria (direction, normalize range), rules (expression trees, enforcement) and
  penalty weights. A constraint `assert` is an expression tree such as `{kind: 'compare', op: 'lte', left: path,
  right: literal}` (`bindingModel.ts:98-126`).
- F14. **Engine-claimed values are not exposed.** `GET /v1/jobs/{id}/report` returns `remote =
  result.provenance.engineReported` (`routes/v1.py:1334-1338`). That field is only the engine's own *provenance*
  (`services/execution.py:115`): the engine's claimed termination, features and objectives are not in any response.
  The raw answer is kept as job evidence (`execution.py:827`, `db/models.py:535`) for re-evaluation
  (`routes/jobs.py:197-262`), and it can expire (410, `routes/jobs.py:233`). `reevaluate_result` records no reason when
  it downgrades a termination or drops a solution (`reevaluate.py:86-132`). The current "engine's own report" card
  reads `remote.termination`, `remote.solutions` and `remote.divergence` (`JobResult.tsx:129-153`), which a real
  engine fills only if it writes them into its provenance.

### Tests, checks, lab
- F15. These tests pin today's run-result UI and must change with it: `pages/Jobs/JobDetail.test.tsx:85-98`
  (figures, the "Chosen providers" region, `Solution 1 source` hidden) and `:163-172` (engine report);
  `e2e/s6a-jobs.spec.ts:392-421`; `pages/Workbench/Workbench.test.tsx:612-622` (cells, `.wb-result-summary`, the
  region `Solution 1` holding `latency10`). JobResult, RunPanel and CheckResult have no unit test file of their own.
- F16. Lessons from earlier slices:
  - A red_before (G3) check rejects import errors, so tests of a module that does not exist yet could not be proven
    red (`openspec/changes/m21-rendering-catalogue/design.md:289-290`).
  - Playwright could not run in the lab, so CI e2e was the evidence (`docs/agent-work/m24-retire-screens/handoff.md:4`).
  - The OpenSpec CLI was missing in the lab (same file, :5).
  - `changelog.generated.json` goes stale with every commit and is regenerated as the last commit
    (`docs/agent-work/m24-retire-composer/handoff.md:5-6`).
- F17. Risk config. R9 (`frontend/src/**/*.tsx`, `*.css`, `frontend/e2e/**`) is **medium**
  (`.agentic/project.yaml:131-133`). R3 (`routes/**`, `docs/openapi.json`) is high if breaking (:113-114). R4 and R7
  cover bim-core and bim-toolchain (:115-126). Panels are at :141-147. The size limit is 300 lines, not counting
  tests and generated files (:14).
- F18. Up to now the frontend has kept `components/` and `pages/`; there is no `widgets/`, `entities/` or `shared/` yet
  (ARCHITECTURE §5.1 describes the target, and M9.3 moves to it).

## 2. Consequences for the plan

1. **Offenders 1 and 4 need no new component.** Offender 1 is dead code (F6), and offender 4 is a fallback string
   (F9). One slice, H1, retires both now, in parallel with the component work. Mapping the workbench list onto
   `DiagnosticsList` is ruled out: there is no severity field, and the open-in-editor buttons would be lost (F9).
2. **The components are pure and parallel.** Each new component, with its pure derivation function, lives in its own
   new files under `components/rendering/`. It takes structural input types declared in its own file, never imports
   from `pages/`, and follows the canonical solution shape of F11, with `metrics` as a fallback (F12). The derivation
   inputs are the solution, the compiled form read by `readBindingProblem` (F13), and the report. The prop contracts
   are fixed in handoff.md so that the page slices can rely on them.
3. **The allow-list has a single writer.** H1, J1 and W1 edit the same two hygiene files, plus ROADMAP status and
   `RENDERING_CATALOGUE.md` (F10). They merge one after another. To recover parallelism, the spec and tests-first
   tasks of J1 and W1 own no shared file and may run while the previous writer is still open.
4. **Tests first without import errors.** A tests-first task writes the tests together with a stub module (the final
   exports and prop types, rendering `null`) and overlays both in the red_before check. The tests then fail by
   assertion on the base, which addresses F16.
5. **EvaluationDiff ships in two steps.** The component accepts the claimed values as optional props. With today's
   API, J1 shows the gateway's re-check, the engine's provenance notes when present, and a plain sentence that the
   engine's own values are not kept for this run. It invents nothing. Showing the real claimed values and the
   downgrade reasons needs data the API does not return (F14). That is an owner decision (CRP-M23-1), and it does not
   block the M2.3 acceptance or R1.
6. **Shape drift fix.** J1 and W1 read `features` first, then `metrics`, and `type`/`scalarization` instead of `mode`.
   They also update their fixtures to the canonical shape (F12).
7. **No public contract change on the R1 path.** No `docs/openapi.json` change, no new dependency, and no gateway file
   is touched by H1, the six component slices, J1 or W1.

## 3. Decision for the owner

### CRP-M23-1: engine-claimed values and downgrade reasons on the run page
Question: may the API expose what the engine claimed, so that `EvaluationDiff` can show "the engine said X, the gateway
evaluated Y, and why it was downgraded" (ARCHITECTURE §5.3)? Today only the engine's provenance is returned (F14).

Options:
- **A, recommended:** an additive change to `GET /v1/jobs/{id}/report`, through a new slice C1.
  - `engineClaimed: {termination, solutions[{decision, features, objectives}]} | null` comes from the kept evidence of
    the final attempt. It is null when the evidence was not kept or has expired.
  - `downgrades: [{code, message, solution?}]` is computed by the gateway by comparing the claim with its evaluation:
    termination changed, a solution dropped as malformed, a hard violation, a termination outside the mode's
    guarantees.
  - No bim-core change, no BIM release, and no retention change. The response is still readable only by the launcher
    (`owned_job`).
  - Risk is high: R3 public API, external input. The OpenAPI delta comes first.
- B: bim-core `reevaluate_result` returns the reasons itself. This is the more exact option, but it is a BIM MINOR
  release (INTENT §11.2) and touches R4/R7. It belongs with M7.
- C: defer. EvaluationDiff stays as in §2.5 until M7 (engines).

Blocks: C1 and J2 only. Without an answer, M2.3 still meets its acceptance with §2.5.

## 4. Risks
- R-a, figures empty on real runs (F12): J1's ui-qa step compares a preview run against the unit fixtures. If confirmed,
  the fix is part of J1 and W1, not a separate change.
- R-b, bounds that are not simple comparisons: `QoSAgainstBounds` positions a value against a bound only for
  `features.<f> <op> <number>` (either order, under an `and`). It lists every other rule as text, with its status from
  the violations. The gateway's violations decide whether a rule is met, never the client's comparison.
- R-c, a rule with a `when` condition: it is shown as "applies when …", with its status from the violations only.
- R-d, Recharts in jsdom: a ResponsiveContainer has no size, so unit tests cover the table, the axis selectors and
  the non-dominated filter. ui-qa and the e2e screenshot cover the drawing.
- R-e, shared files: the allow-list, the hygiene test, `ROADMAP.md`, `RENDERING_CATALOGUE.md`,
  `test/fixtures/jobs.ts` and `Workbench.test.tsx` go one writer at a time (handoff order). The changelog is
  regenerated by the coordinator as each PR's last commit (F16).
- R-f, archive order: every M2.3 delta adds to capability `frontend-rendering`, which exists only in the unarchived
  `m21-rendering-catalogue` change. Archive m21 first. ADDED requirements avoid MODIFIED against a spec that is not
  yet living. That is why V1 adds `req~frontend-rendering-verdict-terminations~1` instead of revising
  `verdict-badge~1`.
- R-g, lab limits: at most two checks run at once (qa-checks), so seven parallel slices queue on the gate. The
  coordinator may cap concurrency at four. Playwright and the OpenSpec CLI may still be missing in the lab (F16), in
  which case CI is the evidence and G1 is reported `NOT EXECUTED` until it runs.
