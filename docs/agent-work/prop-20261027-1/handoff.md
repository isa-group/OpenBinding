# Handoff: prop-20261027-1
- Status: waiting-review (intake done, OpenSpec change and task contracts not started) · Updated: 2026-10-27
- Branch / head: task/63328c22569e4b2f / base `5a47e475` · PR: none

## Goal
Make the report-only G6 trace step in CI read the coverage tags in `lab`, `tools` and `.github/workflows`
(283 tags in 18 files today) so that spec drift there becomes visible on every PR (INTENT O7, `INTENT.md:168,219`).

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261027-1/intake.md` (facts F1-F14, slices S0-S1, gates, CRP-1/2).
- Proposal evidence checked: the path list is at `.github/workflows/ci.yml:289` and `continue-on-error` at `:286`.
  The tag counts match (276 under `lab/` + 3 under `tools/` + 4 in `ci.yml`).
- Not confirmed: the three task ids the proposal cites do not appear in the repository (intake §2, finding 5).
- No check was run. None is registered for this intake task.

## Decisions
- Append `lab tools .github/workflows` after `acceptance` and leave the existing order alone. Reason: the requirement
  says "in that order" (`openspec/specs/gate-tooling/spec.md:58`), and appending keeps the diff to one line.
- `.github/workflows`, not `.github`. Reason: only `ci.yml` holds tags there. The PR template has a `req~…~N`
  placeholder (`.github/pull_request_template.md:6`).
- Split the test constant (`G6_PATHS` stays, add `CI_TRACE_PATHS`). Reason: `G6_PATHS` also pins
  `.agentic/project.yaml:62` through `test_ci_gate_tooling.py:280`. That file is R11.
- A spec delta, `req~gate-tooling-trace-paths~2`. Reason: `~1` lists the six paths (`spec.md:57-72`).
- No feature flag. Reason: CI config, a report-only step, one atomic line.

## Ruled out
- Editing `.agentic/project.yaml` in this change: it is R11, owner only (CRP-2).
- Adding `openspec/changes` to the trace, to resolve the orphaned links: in-flight deltas are not accepted
  requirements. The archive tasks resolve those links instead.
- Moving tags into traced directories (proposal alternative a): more churn, and it breaks file ownership.

## Open questions and risks
- CRP-1 (owner): S1's risk is high by rule (R10 `.github/**`, `REVIEW.md:23,27`). Recommended: an override to low
  (`REVIEW.md:102-106`). Without an answer: the high panel.
- CRP-2 (owner, non-blocking): should the local G6 argv in `project.yaml` follow CI? Recommended: not now.
- Risk: the first wider run reports more defects. Tags point at ids declared only in the unarchived changes
  `ci-speed`, `m05-pr-previews`, `m41-space-bootstrap` and `m45-lab-pricing-wiring` (intake F9). This is an
  inference and was NOT EXECUTED. Mitigation: the step stays report-only, and the MRP groups the defects by source change.
- Risk: S1 collides with any open task that owns `ci.yml` or `test_ci_gate_tooling.py`. Mitigation: serialize.

## Next three steps
1. Coordinator: open the OpenSpec change `prop-20261027-1` (S0) with the MODIFIED requirement text in intake §4,
   then validate it with `openspec validate prop-20261027-1 --strict`.
2. Coordinator: file CRP-1 (and optionally CRP-2), then write S1's contract with the owned lines and the checks of
   intake §4 (red-before on `-k trace_step_covers_g6_paths`, then the file, then `lab-static`).
3. pr-steward on S1's PR: read the `trace` job log with `ci_log`, then record its defect list in the MRP grouped by
   the unarchived change that declares each missing id.

## Evidence
- Tasks: this intake (task 63328c22569e4b2f) · Heads: base `5a47e475` · CI: none run
- Lookup: OFT 4.11.0 scans `.py`/`.yml`; orphaned links are defects (`TagImporterFactory.java` at tag 4.11.0;
  `doc/spec/design.md` on `main`), medium confidence.
