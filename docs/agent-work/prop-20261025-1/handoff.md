# Handoff: prop-20261025-1
- Status: waiting-review (intake done; two owner decisions open) · Updated: 2026-10-25
- Branch / head: task/bb0801c0ace749f8 / base 2bed6fbf · PR: none

## Goal
Give `develop` its own CI result, one run per push and one run per night, so INTENT O6 (`INTENT.md:167`)
becomes measurable.

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261025-1/intake.md` (facts table in section 2, slices in section 4).
- `ci.yml` triggers only on `pull_request` — `.github/workflows/ci.yml:3-5`.
- Adding triggers keeps the existing static test green — `lab/tests/test_ci_gate_tooling.py:424-427`.
- The default branch is `main`, and scheduled runs use the default branch's workflow and commit — lookups
  (api.github.com/repos/isa-group/OpenBinding; docs.github.com events-that-trigger-workflows#schedule).
- `.github/**` is R10 high — `REVIEW.md:23,27`.
- No code, spec or acceptance file changed. No check was run (none is registered for this task).

## Decisions
- Two slices that run one after the other: S1 (push + concurrency + `workflow_dispatch`) and S2 (nightly).
  Reason: S1 is useful on its own and does not depend on the nightly decision.
- The concurrency group includes `github.event_name` and cancels only push runs. Reason: a `develop` push must
  not cancel the nightly or manual run, and PR behaviour stays unchanged.
- Recommend option B for the nightly: a `nightly.yml` that dispatches `ci.yml` on `develop`. Reason: it is the
  only option where `develop`'s own workflow tests `develop`'s code.
- New static tests go in new files under `lab/tests/`. Reason: disjoint ownership, and
  `test_ci_gate_tooling.py` (m03) stays untouched.

## Ruled out
- `schedule` added straight into `ci.yml` (the proposal's first slice). It would test `main`, and only after a
  release, because GitHub runs scheduled workflows from the default branch.
- Claiming that the nightly surfaces the B8 tests. `ci.yml:100-110` deselects them.

## Open questions and risks
- CRP-1, the nightly design (A/B/C/D, intake section 7) — waiting on the owner.
- CRP-2, the risk level (proposal says low, REVIEW says high) — waiting on the owner. The default is the high panel.
- Q1-Q3 (PR cancel policy, where `workflow_dispatch` goes, which OpenSpec change) — waiting on the coordinator.
- Risk: no registered check validates workflow syntax. Mitigation: the PR's own CI run and the first `develop`
  push run are the evidence, and pr-steward reports both.
- Risk: the nightly starts only after a release to `main` (owner merge), and GitHub may delay or drop scheduled
  runs. Mitigation: state this in S2's how_to_review, and keep `workflow_dispatch` for manual runs.

## Next three steps
1. The coordinator opens the CRPs (CRP-1, CRP-2) and an OpenSpec change with `req~ci-develop-push~1` and
   `req~ci-develop-push-concurrency~1` (intake section 4).
2. The coordinator writes the S1 contract: owned `.github/workflows/ci.yml` (`on:` + `concurrency:` only) and
   `lab/tests/test_ci_triggers.py`, checks as in intake section 4, the high panel unless CRP-2 lowers it.
3. After S1 merges and CRP-1 is answered, write S2 for the chosen option, and add `req~ci-develop-nightly~1`.

## Evidence
- Tasks: bb0801c0ace749f8 (this intake) · Heads: 2bed6fbf · CI: none run
