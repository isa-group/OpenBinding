# Handoff: prop-20261103-2
- Status: waiting-review (intake done, CRP pending) · Updated: 2026-11-03
- Branch / head: task/61de66fca0ba4d9c / base b8067258 · PR: none

## Goal
PRs into `develop` stop needing a final `chore(changelog)` commit. The release branch refreshes the changelog JSON
(proposal option (b)).

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261103-2/intake.md`. All nine proposal evidence items checked (F1-F9). F9 is
  partly checked: the followup ids appear in prop-20261102-1/-2 files, but their text was not read.
- New findings: living requirement `req~ci-develop-changelog-pr-only~1` (`openspec/specs/gate-tooling/spec.md:342-353`);
  its test (`lab/tests/test_ci_triggers.py:144-162`); the factory G9 gate and the daily check
  (`.agentic/project.yaml:83,152`, R11); `.github/**` is R10 high (`REVIEW.md:23,27`); more docs teach the old rule
  (`CONTRIBUTING.md:35-38`, `AGENTS.md:95,117-120`, `docs/DEFINITION_OF_DONE.md:29,34`,
  `.github/pull_request_template.md:35`).
- No code or spec written. No checks registered or run.

## Decisions
- Three slices: S0 spec, S1 CI and test (high), S2 docs (low). S1 and S2 ship in one PR. Reason: S2's text is only true
  once S1 lands, and a CI condition cannot be flagged.
- Recommend variant b2 (keep `--check` on PRs into `main`). Reason: it keeps a guard where the JSON is published, and
  the test shape stays the same.
- G9 `changelog` is left out of this change's contracts. Reason: it is the gate the change retires.

## Ruled out
- Options (a) and (c) of the proposal: not chosen by the owner, who approved option (b).
- Regenerating the JSON inside this PR: not needed, because the PR's own CI uses the new `ci.yml`.

## Open questions and risks
- Q1 variant b1/b2, Q2 develop-preview changelog lag, Q3 `.agentic/project.yaml` gate (R11), Q4 high vs low risk,
  Q5 release-role brief outside the repo. All wait on the owner via CRP (intake §7).
- Risk: under b2, `main`-only hotfix commits can make a release PR stale. Mitigation: the release role regenerates
  after syncing.
- Risk: until Q3 is applied, any task contract that lists G9 `changelog` keeps failing. Mitigation: the coordinator
  drops it from contracts (intake F15).

## Next three steps
1. Coordinator: open CRP with Q1-Q5 from intake §7, then create `openspec/changes/prop-20261103-2/` (S0) with the
   delta for `req~ci-develop-changelog-pr-only` per Q1.
2. Contract S1 (implementer, high panel) and S2 (doc-steward, low) in parallel, with the owned files and checks 1-7 of
   intake §4. Then one PR.
3. After the merge: an owner-approved edit of `.agentic/project.yaml:83,152` (Q3), the release-brief update (Q5),
   cleanup of the F15 task contracts, and closure of followups d57e0060abc54294 and 93d43ffc4d834a9f.

## Evidence
- Base b8067258 · Tasks: this intake (61de66fca0ba4d9c) · CI: not read (no repo tool for this role).
