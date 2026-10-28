# Handoff: prop-20261028-2
- Status: waiting-review (plan for the coordinator; CRP-1 for the owner) · Updated: 2026-10-28T12:00:00Z
- Branch / head: task branch on 889db282 · PR: none (planning only)

## Goal
After PR 70 (m23-run-result) merges, make `frontend/e2e/live/04-job-random-search.spec.ts`,
`frontend/e2e/live/visual-qa.spec.ts` and `docs/qa/E2E_PLAN.md:179` wait for the new run result region instead of
the removed "Best combination found" heading (proposal P-20261028-2, INTENT O5).

## State (with evidence)
- Nothing is built. The old wait is at `04-job-random-search.spec.ts:9,67`, `visual-qa.spec.ts:29,293` and
  `E2E_PLAN.md:179`. The heading is still on this base at `frontend/src/pages/Jobs/JobResult.tsx:73`, and the
  infeasible heading at `:41`.
- No `RunResult` component and no "Run result" region exist on `889db282` (intake F5). The region's name is
  unverified.
- PR 70 and follow-up cd24a7f53f824f3d could not be inspected: the repo tool refuses repository operations for this
  role (intake F15).
- No check was run: this task has no registered check, and its output is these two documents.

## Decisions (planner; the coordinator may override)
- One slice, S1. It is about 10-20 lines in 3 files with one capability, so splitting it adds only merge overhead.
- Risk is **medium**, not low. Reason: `frontend/e2e/**` is R9 (`REVIEW.md:22,27`). Only an owner override can lower
  it (CRP-1).
- The locator is read from PR 70's merged code and its mocked spec `e2e/s6a-jobs.spec.ts`, not from the proposal
  text. Reason: the name is unverifiable on this base (F5).
- The new wait must prove that a finished result is on screen, not just a container. Reason: blocking criterion 6,
  no weakened assertion (`REVIEW.md:91`).
- G3 is a text guard (STALE grep, red on the base), because the live specs need a running stack (F7). Behavioural
  evidence is G12 `playwright-live` on the lab or preview.
- `support.ts` stays untouched. Reason: every live spec shares it, and the locator stays local to each spec.

## Ruled out
- Adding the live specs to PR 70: the proposal's alternative. It widens a PR that is under review and has conflicts.
- Running the live specs in CI: they need the lab stack and seed password (`.agentic/project.yaml:95`), and that is
  out of scope.
- `tsc -b` as a compile gate for `e2e/**`: it does not include them (`frontend/tsconfig.app.json:33-35`).
  `playwright test --list` is used instead.

## Open questions and risks
- CRP-1 (owner): keep S1 at medium (recommended) or lower it to low by override (intake §7).
- Q1 (coordinator): PR 70's merge into `develop` and its SHA. S1 does not start before then (owner note).
- Q2 (coordinator): did cd24a7f53f824f3d already edit `E2E_PLAN.md:179`? If yes, S1 drops that file. If it is open,
  it merges first.
- Q3/Q4 (implementer, from merged code): the region name, the infeasible heading, and the locator PR 70's mocked
  spec uses.
- Risk: if the region is mounted while the job is still running, a wait on it alone would pass early. Mitigation:
  constraint 2, assert finished content inside the region.
- Risk: the lab may lack a browser for MOCKED. Mitigation: CI e2e is the evidence, as in earlier m23 slices.

## Next three steps
1. Coordinator: confirm that PR 70 is merged into `develop` (SHA) and check the state and diff of cd24a7f53f824f3d on
   `docs/qa/E2E_PLAN.md`. Send CRP-1 with option A recommended.
2. Coordinator: open the S1 implementer task on `develop` after PR 70 (and cd24a7f53f824f3d, if open). Give it the
   owned files, read-only context, constraints 1-4 and the checks FI, STALE (red_before), LINT, LIST and MOCKED from
   intake §3-§4.
3. After S1 merges: run `playwright-live` on the lab or preview. Attach the `04-job-random-search` result and the
   `VQA … page=job-result` lines for desktop and mobile to the review package, and hand the `job-result` screenshots
   to ui-qa.

## Evidence
- Planning task on 889db282. No lookups, because every fact is in the repository or unreachable by policy (F15). No
  check registered or run.
