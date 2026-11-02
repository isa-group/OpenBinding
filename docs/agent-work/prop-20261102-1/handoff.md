# Handoff: prop-20261102-1
- Status: waiting-review (intake done; S1 ready for a task contract once Q1 is answered) · Updated: 2026-11-02
- Branch / head: task/6f22d9607be74586 / base 5b4c68a6 · PR: none

## Goal
Record in the `ROADMAP.md` M0 and M2 Status cells and dated paragraphs what #74, #75 and #78 delivered, and what
still blocks M0.8, M0.9 and M2.7 (INTENT O7, `INTENT.md:168`). Milestone text stays as it is (`INTENT.md:234`).

## State (with evidence)
- Intake written: `intake.md`, with findings F1-F8, one slice S1, checks 1-5, gates and Q1-Q3.
- #75 and #78 are squash subjects in the base history (`c1e7b9f5`, `aa4c98d5`). #74 is not verified: it is not in
  the visible history, and the base contains local integrations (`98aada47`).
- The proposal overstates all three slices:
  - M0.8: S1 (`engine_incompatible`) is not built, waiting on CRP-M08-1; the 1.1.2 release waits on CRP-M08-2
    (`openspec/changes/m08-qacobench-baseline/tasks.md:14-19,37-38`; no match in `docs/ERRORS.md` or
    `docs/openapi.json`).
  - M0.9: the production `compose config` in CI waits on CRP-M09-3, and F4/F7 wait on CRP-M09-2
    (`openspec/changes/m0-infra-close/tasks.md:121-160`).
  - M2.7: #74 is part 1 of 2, and 40 page files are still pending
    (`frontend/src/test/digestHygiene.test.ts:77-133`).
- The M0 part of P-20261027-2 S1 is not applied (`ROADMAP.md:18` lacks M0.2 and M0.9), and that slice also owns
  `ROADMAP.md`.

## Decisions
- D1: one slice, S1 `ROADMAP.md`. Reason: one capability in one file.
- D2: low risk, panel `[reviewer]`. Reason: no risk-area glob, not R11 (`.agentic/project.yaml:105-142`).
- D3: no feature flag. Reason: documentation only.
- D4: the status says "partly" for M0.8, M0.9 and M2.7, never "done". Reason: their acceptance cells
  (`ROADMAP.md:44,45,72`) are not met (F3-F5).
- D5: merges and dates come only from check 1. Reason: this role cannot run `git log` or use the repo tool.

## Ruled out
- "M0.8 code done", "M0.9 done", "M2.7 merged" as the proposal words them: contradicted by F3-F5.
- Editing the acceptance cells or the M0.8 deliverable (moving the 1.1.2 release out of M0): that needs a CRP, and
  the owner already has that question (`docs/agent-work/roadmap-full/plan.md:219-221`).
- Running this slice in parallel with P-20261027-2 S1: both own `ROADMAP.md`.

## Open questions and risks
- Q1-Q3 in `intake.md` §7 are for the coordinator. None needs a new CRP.
- Risk: #74 may not be in `develop`. Mitigation: check 1; S1 leaves M2.7 as it is if #74 is missing.
- Risk: the changelog check fails until the `chore(changelog)` commit. That is expected (lessons 2).
- Risk: the BIM guard scans `ROADMAP.md` too. Mitigation: check 3.

## Next three steps
1. Coordinator: answer Q1 (fold the P-20261027-2 M0 items: recommended), Q2 and Q3. Then open S1 (`ROADMAP.md`)
   with checks 1-3 of `intake.md` §4.
2. S1 writer: run check 1 (and check 5), then edit `ROADMAP.md:18,20` and the paragraphs `:47-51,75-82`, dated
   2026-11-02, following `intake.md` §3. Run checks 2 and 3.
3. Coordinator: add the `chore(changelog)` commit, run check 4, then send the PR to the reviewer with the
   `how_to_review` of `intake.md` §5 (G13).

## Update 2026-11-02 (doc-steward, S1 applied)
- Changed: `ROADMAP.md` M0 and M2 Status cells and the two dated paragraphs only (now dated 2026-11-02).
- Q1 = fold: M0.2 done (#56), M0.5 repository slices merged (#34, #39, #41; live acceptance not recorded),
  M0.9 via #60 and #75. Q2: "production `compose config` is not in CI yet (CRP-M09-3)". Q3: PR numbers and CRP ids
  only, no new change ids.
- Evidence, check 1 (`git log`, committer dates): #74 ff3c2188 2026-10-28; #75 c1e7b9f5 2026-10-28; #78 aa4c98d5
  2026-10-28; #56 49f6cba0 2026-10-26; #60 058b4e1b 2026-10-26; #34 and #39 2026-10-24; #41 2026-10-26.
  No M2.6 squash is shown, so "M2.6 in flight, not merged" stays.
- Check 5: `engine_incompatible: absent` in `docs/ERRORS.md` and `docs/openapi.json`; `deploy/kubernetes` has 0 files.
- Wording: M0.8, M0.9 and M2.7 say "partly", never "done". M0.5 stays "in progress" in the paragraph.
- Left out: nothing; every requested PR appeared in check 1. The changelog is not regenerated (the lead does it last).

## Evidence
- Task: this intake (planner; no registered checks, none run). Base head `5b4c68a6`.
- The repo tool was refused for this role (`pr_get` 74: "this role cannot use repository operations").
