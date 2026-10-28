# Handoff: prop-20261028-3
- Status: waiting-review (plan for the coordinator) · Updated: 2026-10-28T00:00:00Z
- Branch / head: task/33208afe625d4f85 on 889db282 · PR: none (planning only)

## Goal
Remove the hard-coded screen count and allow-list ceiling from `frontend/src/routes/retiredScreens.test.tsx`. Slices
that retire screens or offenders (M2.3, M2.5, M2.6) then no longer have to edit a file they do not own (P-20261028-3,
O5 and O12). The facts F1-F13 are in [intake.md](intake.md).

## State (with evidence)
- Nothing is built. The pins are still in place: 69 at `retiredScreens.test.tsx:110,190,246,275`, 12 at `:140,276`,
  and the `MAX_ALLOWED_OFFENDERS` import at `:8`.
- Both counts already have an owner. The screen count is in `routes.test.ts:58-66`, with all five screen-count tags.
  The ceiling is in `rawRenderingHygiene.test.ts:138,363-370`.
- No m25, m26 or m23 H1/J1/W1 change exists on this base. m26 A1 claims `frontend/src/routes/**`
  (`m26-navigation/handoff.md:63`).
- Not verified: the content of PR 70 and followup `c80f81011f1541dc`. This role cannot read PRs, and the id appears
  nowhere in the tree.
- No check was run: none is registered for this task, and the output is two documents.

## Decisions (planner; the coordinator may override)
- One slice S1 owns the one file. Reason: about 10 deleted lines, one capability.
- Delete the six pins and the import instead of replacing them, which departs from the proposal. Reasons:
  - A1's registry count does not exist yet, and the screen count already has its owner (`routes.test.ts:64`).
  - Comparing `MAX_ALLOWED_OFFENDERS` with `RAW_RENDERING_ALLOW_LIST.length` repeats `ceilingMismatch` and keeps the
    import that m25 S0 removes.
- Remove the screen-count `utest` tags at `:241,270`. Reason: those tests no longer count, and the requirements stay
  covered at `routes.test.ts:61-62`.
- Risk is high by area: R1 covers `frontend/src/routes/**` (`REVIEW.md:14,27`). In substance it is low (test-only).
- No feature flag. No CRP: the owner approved the work and the ordering rule.

## Ruled out
- Adding the file to every slice that lowers a count. Every one of them would still conflict on the same lines.
- Asserting `MAX_ALLOWED_OFFENDERS === RAW_RENDERING_ALLOW_LIST.length`. S0 would still have to edit the file.
- Touching the e2e pins (`qa-gallery.spec.ts:203`, `routes-smoke.spec.ts:90`). They belong to m26 A3.

## Open questions and risks
- Q1 (coordinator): own PR after PR 70 (recommended), or folded into m25 S0 (owner's fallback). If A1 holds
  `frontend/src/routes/**`, S1 waits for A1, or the edits go into A1.
- Q2 (coordinator): whether a no-delta OpenSpec change is wanted. `openspec validate --strict` on such a change is
  unverified.
- Q3 (coordinator): run the high panel as REVIEW.md says. The proposal said low.
- Q4 (coordinator): the m25 S0 contract must keep the export `RAW_RENDERING_ALLOW_LIST`, which `:138` reads.
- Risk: PR 70 may change the pinned values or the file. Mitigation: S1 deletes whatever pins are there after a
  rebase, and check 2 (intake §4) is written so that it does not depend on the values.

## Next three steps
1. Coordinator: when PR 70 has merged into `develop` and no running slice holds `frontend/src/routes/**`, open S1.
   Use the owned file, the three edits (intake §3) and checks 1-6 (intake §4), with check 2 as the red-before.
2. Coordinator: if m25 S0 is about to start and S1 cannot, add the same three edits and the file to S0's owned files
   (option B).
3. After S1 merges: close followup `c80f81011f1541dc`, and note for the m24 archive task that it should drop
   `retiredScreens.test.tsx` from the screen-count evidence (`m24-retire-sponsorship/spec.md:166`, `design.md:86`).

## Evidence
- Planning task 33208afe625d4f85 on 889db282. Facts with file:line are in intake.md §2. No lookups were needed. No
  checks were registered or run.
