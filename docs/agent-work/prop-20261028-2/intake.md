# Intake: P-20261028-2, live e2e specs and E2E_PLAN wait for the run result region

- Kind: maintenance, size S, owner-approved **for after PR 70 (m23-run-result) merges, not before** (owner note).
  Not auto-start: it depends on PR 70 and on follow-up cd24a7f53f824f3d.
- Base read: `task/8b2f84f906ee4c95` at `889db282`. The planner writes only `docs/agent-work/prop-20261028-2/*`.
- INTENT objective: **O5, Rendering**. The live `visual-qa` run feeds ui-qa, and its `job-result` screen is the only
  screen in the gallery taken from a real run.

## 1. Objective

When PR 70 replaces the run result screen, the two live Playwright specs and the E2E plan must wait for the new run
result instead of the level-2 heading "Best combination found". Otherwise the lab journey `04-job-random-search` and
the `job-result` screen of `visual-qa` time out.

## 2. Facts checked on `889db282`

| # | Fact | Evidence |
|---|---|---|
| F1 | `04-job-random-search` defines `RESULT = /Best combination found\|Solution \d+ of \d+\|Why no combination works/` and waits up to 180 s for a level-2 heading with that name | `frontend/e2e/live/04-job-random-search.spec.ts:9,67` |
| F2 | `visual-qa` defines the same pattern as `RESULT_HEADING` and uses it as the `ready` locator of the `job-result` stop. The walk waits 45 s with `expect.soft`, so a miss is a soft failure plus a screenshot of the wrong state, not a skipped screen | `frontend/e2e/live/visual-qa.spec.ts:29,290-294,190` |
| F3 | The E2E plan describes the same wait | `docs/qa/E2E_PLAN.md:179` |
| F4 | On this base, the heading still exists: `Solution n of m` or `Best combination found` at `<h2 id="job-best">`. The infeasible branch is `<h2 id="job-infeasible">Why no combination works</h2>` | `frontend/src/pages/Jobs/JobResult.tsx:73,41` |
| F5 | Nothing named "Run result" exists on this base. There is no `RunResult` component, no `aria-label`, and no `openspec/changes/m23-job-run-result`. The planned composition is `components/RunResult/RunResult.tsx` (J1), which keeps the infeasible state | `docs/agent-work/m23-run-result/handoff.md:20,85-87,94`; grep for `RunResult` over `frontend/src` finds nothing; `openspec/changes/` has only the six `m23-*` component changes |
| F6 | J1 (PR 70) owns the mocked specs and unit tests that also pin the old heading: `e2e/s6a-jobs.spec.ts:393,440,485` and `pages/Jobs/JobDetail.test.tsx:88,206,310`. They are **not** in this proposal's scope | `docs/agent-work/m23-run-result/handoff.md:48` |
| F7 | The live specs run only against a running stack: the `live` project of `playwright.config.ts` (`testMatch: '**/live/**/*.spec.ts'`), or `playwright.live.config.ts` in the lab's `e2e` service. The `mocked` project ignores them, and no CI workflow runs them | `frontend/playwright.config.ts:28,33`; `frontend/playwright.live.config.ts:21-22`; grep of `.github/workflows` for `live\|visual-qa` finds nothing |
| F8 | The registered live check is `playwright-live` (G12), which needs `lab-stack` and `LAB_SEED_PASSWORD` | `.agentic/project.yaml:95` |
| F9 | `tsc -b` does not type-check `e2e/**` (it includes only `src` and `vite.config.ts`). ESLint lints every `**/*.{ts,tsx}`, including `e2e/live` | `frontend/tsconfig.app.json:33-35`; `frontend/tsconfig.node.json:25`; `frontend/eslint.config.js:12` |
| F10 | The seed password is read lazily inside `labPassword()`. Loading the live specs (`--list`) needs no secret | `frontend/e2e/live/support.ts:39-43` |
| F11 | **Risk is medium, not low.** `frontend/e2e/**` is R9 (medium). R0 (low) covers only "tests only … outside the globs above", and "the highest-risk area touched sets the PR risk level". The medium panel is reviewer + test-reviewer | `REVIEW.md:22,25,27,34`; `.agentic/project.yaml:131-133,143` |
| F12 | A weaker assertion blocks the merge | `REVIEW.md:91` (blocking criterion 6) |
| F13 | The live specs carry no OpenFastTrace tags (`utest->`, `req~`) | grep over `frontend/e2e/live` finds 0 |
| F14 | `E2E_PLAN.md:183` (the `visual-qa` row) says "a finished job's result" without naming the heading, so it needs no change. No other doc names the heading | `docs/qa/E2E_PLAN.md:183`; repo grep for `Best combination found` |
| F15 | Not verifiable from this task: (a) PR 70's head and whether it is merged; (b) follow-up cd24a7f53f824f3d and the three tasks a3051a1c9e934ddc, 050f2c0ca08d4766, 697f3a5bdbe84d02 (none is in the repository); (c) the exact accessible name of the new region and whether the infeasible heading survives. The repo tool refused `pr_get` for this role | tool answer "this role cannot use repository operations" |

## 3. Scope and non-goals

In scope (one capability: the live journey and the visual QA find the new run result):

- `frontend/e2e/live/04-job-random-search.spec.ts`: replace `RESULT` and the `:67` wait with a wait on the run result
  region PR 70 renders. Keep the infeasible branch as an alternative, so a run with no feasible combination still
  passes.
- `frontend/e2e/live/visual-qa.spec.ts`: replace `RESULT_HEADING` and the `job-result` `ready` locator (`:29,293`) the
  same way.
- `docs/qa/E2E_PLAN.md:179`: the row of `04-job-random-search` describes the new wait.

Design constraints for the implementer:

1. **Read the name from merged code, not from the proposal.** Take the region's accessible name and the infeasible
   heading from PR 70 as merged in `develop` (`components/RunResult/**`, `pages/Jobs/JobResult.tsx`) and from its
   mocked spec `e2e/s6a-jobs.spec.ts`. Use the same locator the mocked spec uses, so both suites share one contract.
2. **Do not weaken the assertion (F12).** The wait must prove that a finished result is on screen, not only that a
   container exists. If the region is mounted while the job is still queued or running, add a second assertion on
   finished content inside it, such as the verdict or the binding table. That keeps the 180 s wait meaningful.
3. One shared locator per spec, a `RegExp` or a `Locator` factory. Do not move it into `support.ts`, because that file
   is shared by every live spec and is outside this slice.
4. No change to timeouts, the capture names (`job-result`) or the walk.

Non-goals:

- The mocked specs and unit tests that pin the old heading (F6). They belong to PR 70 (J1).
- Product code under `frontend/src/**`.
- `acceptance/**` and `openspec/specs/**`.
- Adding the live specs to CI (F7).
- Changing `support.ts` or the `visual-qa` criteria.

## 4. Slices

One slice. It is under 30 diff lines, has a single capability and three files, so splitting it would only add merge
overhead.

| # | Slice | Role · turns | Owned files (exclusive) | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | Live specs and E2E plan wait for the run result region | implementer (default model and effort) · 25 | `frontend/e2e/live/04-job-random-search.spec.ts`, `frontend/e2e/live/visual-qa.spec.ts`, `docs/qa/E2E_PLAN.md` (only the `04-job-random-search` row at `:179`, plus a dated note under "What was corrected" if the implementer adds one) | PR 70 as merged: `frontend/src/components/RunResult/**`, `frontend/src/pages/Jobs/JobResult.tsx`, `frontend/e2e/s6a-jobs.spec.ts`; `frontend/e2e/live/support.ts`; `frontend/playwright.live.config.ts`; `docs/agent-work/m23-run-result/handoff.md` | about 10-20 lines (2 constants, 2 locators, 1 table row) | **medium**: R9 `frontend/e2e/**` (F11). The content risk is small: tests and docs only, no runtime change | (1) PR 70 merged into `develop`; (2) cd24a7f53f824f3d merged or closed, because it may also edit `E2E_PLAN.md`. Rebase S1 on `develop` after both |

Ownership: `docs/qa/E2E_PLAN.md` is a shared document. While S1 runs, S1 is its only writer. If cd24a7f53f824f3d is
still open, it must merge first. If it already rewrote `:179`, S1 drops that file and owns only the two specs.

### Proposed checks (argv; the coordinator registers them)

- FI: `["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile"]`
- STALE (red_before on the base, green after; a text guard, since the live specs cannot run outside the lab):
  `{"argv":["bash","-c","set -euo pipefail; if grep -rnE 'Best combination found' frontend/e2e/live docs/qa/E2E_PLAN.md; then exit 1; fi"],"type":"red_before","expect_exit":[1],"expect_pattern":"Best combination found"}`
  On the base it must exit 1 and print `04-job-random-search.spec.ts:9`, `visual-qa.spec.ts:29` and `E2E_PLAN.md:179`.
  After the change it must exit 0.
- LINT: `["bash","-c","set -euo pipefail; cd frontend; pnpm exec eslint e2e/live"]` (F9)
- LIST, which loads and compiles every live spec with no browser and no secret (F10):
  `["bash","-c","set -euo pipefail; cd frontend; E2E_RESULTS_DIR=\"$TMPDIR/e2e-live\" pnpm exec playwright test -c playwright.live.config.ts --list --reporter=list"]`
- MOCKED regression, to confirm that PR 70's contract is the one the live specs now use:
  `["bash","-c","set -euo pipefail; cd frontend; pnpm exec playwright test --project=mocked e2e/s6a-jobs.spec.ts --reporter=line"]`,
  timeout 900. If the lab has no browser, CI is the evidence (`docs/agent-work/m23-run-result/intake.md` F16).
- G12 live: the registered `playwright-live` (`.agentic/project.yaml:95`) on a lab or preview that runs `develop`
  with PR 70 plus S1. It needs `lab-stack` and the seed password, so it is a controller/lab run, not a worker check.

## 5. Gates for S1

| Gate | S1 |
|---|---|
| G1 spec | No delta spec: no behaviour changes (F13, `REVIEW.md:87` concerns behaviour). The coordinator may open a tasks-only OpenSpec change (`proposal.md` and `tasks.md`) if the flow requires one, and run `openspec validate <id> --strict`. If the lab lacks the CLI, report NOT EXECUTED |
| G2 EPIC | n/a without a delta spec; otherwise spec-auditor on the tasks-only change |
| G3 red-before | STALE (above) is red on the base. The behavioural red, a 180 s timeout on a lab with PR 70, is lab evidence. Record it from the first lab run after PR 70 if one exists. The specs cannot run without a stack (F7) |
| G4 acceptance frozen | trivially met: `acceptance/**` is untouched |
| G5 green-after | STALE green, LIST exits 0, and MOCKED `s6a-jobs` stays green |
| G6 trace | n/a: the live specs carry no requirement tags (F13), and `oft-trace` is `todo: true` (`.agentic/project.yaml:62`) |
| G7 contracts | n/a: no API or schema |
| G8 mutation | n/a: no production code |
| G9 quality | LINT on `e2e/live`. `typecheck-build` does not cover `e2e/**` (F9), and LIST is the compile proof |
| G10 secrets/ownership | no secret: the password stays in the environment (`support.ts:39-43`), and no forbidden path is touched |
| G11 review | medium panel: reviewer + test-reviewer (`REVIEW.md:34`). test-reviewer checks that the wait is not weaker than before (F12, constraint 2). Low only with an owner override (CRP-1) |
| G12 lab/UI | `playwright-live` on the lab or preview: `04-job-random-search` passes, and `visual-qa` reports `page=job-result result=PASS` (or only real visual findings, never "the screen did not arrive") on desktop and mobile. ui-qa receives the `job-result` screenshots of the new run page |
| G13 review package | `how_to_test`: the STALE before/after output, the LIST output, and the lab `VQA … page=job-result` lines with the run's head SHA. No UI change of its own, so no new screenshots beyond the lab's `job-result` pair |

## 6. Feature flags

None. The change is test and docs only, ships as one slice and has no runtime effect. Its activation condition is
the merge order: it starts after PR 70.

## 7. Open questions

Needing a CRP (owner):

- **CRP-1, risk level.** The proposal says low, but `frontend/e2e/**` is R9 medium (`REVIEW.md:22,27`, F11).
  Options:
  - A (recommended): keep medium. The only extra cost is a test-reviewer, which also guards blocking criterion 6.
  - B: the owner lowers S1 to low by a recorded override (`REVIEW.md:102-106`).

For the coordinator (facts, no owner decision):

- Q1: Has PR 70 merged into `develop`, and at which SHA? S1 must not start before then (owner note).
- Q2: Has follow-up cd24a7f53f824f3d edited `docs/qa/E2E_PLAN.md:179` (owner note)? If yes, drop `E2E_PLAN.md` from
  S1. If it is still open, merge it first.
- Q3: What are the exact accessible name of the run result region in PR 70, and the heading of its infeasible state?
  The proposal says `Run result`, which could not be verified on `889db282` (F5, F15). The implementer reads both
  from merged code (constraint 1).
- Q4: Do PR 70's mocked specs (`s6a-jobs.spec.ts`) and `qa-gallery.spec.ts` already wait on the same region? If
  yes, S1 reuses that locator verbatim.
