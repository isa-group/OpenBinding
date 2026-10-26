# Handoff: prop-20261026-2
- Status: waiting-review (intake done; S1 waits on the base CRP and on Q1) · Updated: 2026-10-26
- Branch / head: task/797b60020eb7492d / base 212b9662 · PR: none

## Goal
Bring the M2 Status cell and the M2 slice-status paragraph of `ROADMAP.md` up to date after PR #51 and PR #53
(INTENT O12, `INTENT.md:173`), without touching milestones (`INTENT.md:234`, `AGENTS.md:164-165`).

## State (with evidence)
- Slice 1 is already shown as merged in `ROADMAP.md:20` and `:75-76`. The proposal's claim that it is "under review"
  is wrong. Only slice 2 is stale.
- PR #51 (`de85b82b`) and PR #53 (`212b9662`) are both in the base history. CI was green at `4d6191b1` (#51) and
  `59d0ad22` (#53) (`ci_status`, 8/8 check runs each).
- Offenders 5 (`pages/Reports/RepDetail.tsx`) and 7 (`pages/Analysis/Inspector.tsx`) are gone from the tree and from
  the allow-list (`frontend/src/test/rawRenderingAllowList.ts:23,62-89`). Offender 11 remains (`:104-110`).
- Next slice: library catalogue and project resources (`openspec/changes/m24-retire-screens-2/tasks.md:82-84`).
- Plan: one low-risk slice S1 on `ROADMAP.md`, about 4-8 lines (`intake.md` sections 3-5).

## Decisions
- D1: one slice, no flag. Reason: one doc file, one capability, a few lines.
- D2: risk low, panel `[reviewer]`. Reason: `ROADMAP.md` is in no risk-area glob (`.agentic/project.yaml:105-139`),
  and the edit is a Status update only.
- D3: dates come from `git log` (committer date of the squash), never from the proposal alone. Reason: the planner
  could not read the PR merge time (`pr_get` is refused for this role).
- D4: offender 11 stays unmarked. Reason: it is still on the allow-list.

## Ruled out
- Updating `INTENT.md` O5/O12 "Today" cells: R11, owner-only (`project.yaml:137-139`).
- Folding the update into slice 3's PR: rejected by the proposal (it mixes concerns and delays the update).

## Open questions and risks
- Q1: mark offenders 5/7 in the "at 912648c" snapshot list (`ROADMAP.md:86,88`), or record their removal only in the
  dated paragraph? Recommended: only in the paragraph. Waiting on the coordinator; a CRP only if the coordinator
  reads the annotation as beyond the Status column.
- Q2: `crp-ob-set-base-develop-m24` is not recorded in the repository. Waiting on the coordinator or the owner.
- Risk: the offender-to-PR mapping (5 → PR #53, 7 → PR #51) was inferred from screen names. Mitigation: the reviewer
  checks it with `git show --stat de85b82b 212b9662`.
- Risk: "Check generated changelog" fails until the coordinator's `chore(changelog)` commit (`ci.yml:380-384`).
  This is expected.

## Next three steps
1. Coordinator: answer Q1 and Q2, open the S1 task contract on `ROADMAP.md`, and register checks 1-3 of `intake.md`
   section 4.
2. S1 writer: run check 1 for the dates, edit `ROADMAP.md:20` and `:75-78` (and `:86,88` if Q1 = annotate), date the
   paragraph 2026-10-26, then run check 2.
3. Coordinator: add the `chore(changelog)` commit, run check 3, then send the PR to the reviewer with the
   `how_to_review` of `intake.md` section 5 (G13).

## Evidence
- Tasks: this intake (planner, no registered checks, none run). CI read: `ci_status` of PR #51 and PR #53.
- Heads: 212b9662 (base), 4d6191b1 (#51 CI), 59d0ad22 (#53 CI).
