# Handoff: prop-20261027-2
- Status: waiting-review (intake done; S1 and S2 ready for task contracts) · Updated: 2026-10-27
- Branch / head: task/eabed036351747bb / base 5a47e475 (PR #66 squash) · PR: none

## Goal
Bring the `ROADMAP.md` Status cells and dated paragraphs for M0, M2 and M4, and the CI job list in `AGENTS.md`, up to
date (INTENT O7, `INTENT.md:168`). Milestones stay as they are (`INTENT.md:234`).

## State (with evidence)
- Intake written: `intake.md`, with findings F1-F8, two slices, checks, gates and Q1-Q5.
- M2.4 slice 5 (#66) is the base head, but the roadmap still calls it "under review" (`ROADMAP.md:20,77-78`). The
  proposal's claim about slice 3 is wrong: `ROADMAP.md:20,77` already say slice 3 is merged.
- M0.5 S1a+S2 (#41) is merged (`3395c79d`), and the roadmap still says it is open (`ROADMAP.md:50`).
- M0.9: Kubernetes is removed, and the production overlay and runbook exist (PR #60, `m09-compose-only`). The CI
  `compose config` for lab and production is still open (`openspec/changes/m09-compose-only/design.md:139`).
- M0.2: the proof is on the PR 56 merge ref (`docs/agent-work/m02-openspec-strict/summary.md:38-41`). The merge commit
  was not read.
- #63 is slice A2 of the M4.1 profile wiring, not the M4.5 deliverable (`m45-lab-pricing-wiring/proposal.md:34`).
  #40 (M4.1 part 2) is also missing from the M4 status (`changelog.generated.json:24`).
- `AGENTS.md:43` lists 4 jobs, and `ci.yml` has 12. `AGENTS.md:50,89` are stale too. `TESTING.md:114-126` is current.
- `ci_status` read: PR 56 `baa39f20`, PR 60 `3e2cb7a5` and PR 63 `b133118b`, all 8/8 success.

## Decisions
- D1: two slices (S1 `ROADMAP.md`, S2 `AGENTS.md`), parallel, disjoint, one capability each. Reason: owner progress view
  and agent guide are separate concerns. One PR is allowed, which saves a changelog cycle.
- D2: both slices low risk with the `[reviewer]` panel. Reason: neither file matches a risk glob or R11
  (`.agentic/project.yaml:105-139`).
- D3: no feature flag. Reason: documentation only.
- D4: merges and dates come only from `git log` (check 1). Reason: the planner cannot run `pr_get` or `git` and read
  merge facts indirectly.
- D5: M2.4 stays "in progress" after slice 5. Reason: the endpoint `Deprecation`/`Sunset` step waits on an owner CRP
  (`ROADMAP.md:69,78-79`).

## Ruled out
- Recording #63 as "M4.5 merged": its proposal says the gateways are not wired, and lab/previews are out of scope.
- Editing `ROADMAP.md:38` (acceptance text) without a CRP.
- ROADMAP-only (proposal alternative a): `AGENTS.md:43` has already been deferred once (`docs/agent-work/ci-speed/handoff.md:7`).

## Open questions and risks
- Q1-Q5 in `intake.md` §7 are for the coordinator. None needs a CRP unless Q1 = (b).
- Risk: #56, #60 or #63 may not be in the base, because the planner did not read their merge commits. Mitigation:
  check 1, and S1 drops any claim it does not show.
- Risk: the changelog check fails until the `chore(changelog)` commit. This is expected (`ci.yml:502-504`).
- Risk: the stale-status pattern comes back. Leads write "under review" into the roadmap before the merge
  (`m24-retire-sponsorship/handoff.md:2`). See followups.

## Next three steps
1. Coordinator: answer Q1-Q5, then open S1 (`ROADMAP.md`) and S2 (`AGENTS.md`) with the checks in `intake.md` §4.
2. S1 writer: run check 1, then edit `ROADMAP.md:18,20,22` and the paragraphs `:47-51,75-79,130-135` (dated
   2026-10-27). Run check 3. S2 writer: run check 2, edit `AGENTS.md:43` (and `:50,89` if Q3 = yes), then run
   check 3.
3. Coordinator: add `chore(changelog)`, run check 4, then send the PR to the reviewer with the `how_to_review` of
   `intake.md` §5.

## Evidence
- Task: this intake (planner; no registered checks, none run). Base head `5a47e475`.
- `ci_status`: PR 56, PR 60 and PR 63, all success. `pr_get` was refused for this role.
