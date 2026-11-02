# Handoff: prop-20261102-3
- Status: waiting-review (intake done, waiting on the coordinator and CRP-1..3) · Updated: 2026-11-02
- Branch / head: task/48bc1923a4fd4541 / base 5b4c68a6 · PR: none

## Goal
Measure INTENT O6 (develop CI green days, flaky age) and O7 (median change size, ready-to-merge lag), which
`INTENT.md:167-168` marks "not measured". A read-only stdlib tool, `tools/flow_metrics.py`, writes
`docs/qa/FLOW_METRICS.md`.

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261102-3/intake.md`, with evidence F1-F16 checked against `5b4c68a6`.
- No code, spec or acceptance written (planner scope).

## Decisions
- Three sequential slices: S1 (O6 + tool skeleton), S2 (O7), S3 (first dated page). Reason: S1 and S2 together are
  about 310-390 non-test lines, over the ~300 limit. S1 and S2 share `tools/flow_metrics.py`, so they cannot run in
  parallel.
- No feature flag. Reason: nothing in CI or at runtime calls the tool, and the page arrives only in S3.
- All slices are low risk. Reason: `tools/`, `lab/tests/` and `docs/qa/` match no risk glob (`REVIEW.md:14-27`).
- Fixtures are synthetic and API-shaped, not recorded responses. Reason: `INTENT.md:197`, `project.yaml:174-175`.
- Report two size figures (generated excluded; generated and tests excluded). Reason: `project.yaml:14` excludes tests,
  the proposal does not (CRP-3).
- Tests go in `lab/tests/` and run the script like `test_ci_shard.py:10-19`.
- The tool is not named `tools/ci_*.py` and its name has no `bim`. Reason: `tools/ci_changes.py:58-59,78`.

## Ruled out
- A workflow that runs the tool. Reason: `.github/**` is R10 (high) and outside the proposal (CRP-1 option C).
- Reading the ready time from the PR object. Reason: the PR object has no such field. It is the `ready_for_review`
  issue event (lookup, GitHub REST docs).
- Editing `FLAKY_TESTS.md` or `INTENT.md`. Reason: out of scope; INTENT is R11.

## Open questions and risks
- CRP-1: who runs the tool for real and with which token — waiting on the owner via CRP. `github.token` exists only
  in workflows (`nightly.yml:31`).
- CRP-2: definition of a green day and of the denominator — waiting on the owner. The default is in intake §7.
- CRP-3: which size counts for O7, the test globs, and whether `docs/agent-work/**` counts — waiting on the owner.
- Q4-Q6 for the coordinator: how E2 and E3 are left out (`--not-counted`), the default window of 30 days, and one
  OpenSpec change.
- Risk: the nightly fires only once `nightly.yml` is on `main` (`nightly.yml:3-4`), so the days with runs may be only
  push days. Mitigation: the page shows run counts per event.
- Risk: E1-E7 have no first-seen date (`FLAKY_TESTS.md:31-32`), so the flaky half of O6 stays partial. Mitigation:
  report "unknown date" ids. Filling the dates is a followup.
- Risk: the API facts (1,000-result cap, rate limits) come from docs read through a lookup at medium confidence.
  Mitigation: the tool narrows by `created` range and pages.

## Next three steps
1. Coordinator: open CRP-1..3 with the options in intake §7, and create the OpenSpec change `flow-metrics` (capability
   `gate-tooling`, six requirements in intake §4).
2. After G1/G2, contract S1 (owned files, checks 1-7 in intake §4) for an implementer. Then S2 after S1 merges.
3. After CRP-1 is answered, contract S3 so the first `docs/qa/FLOW_METRICS.md` is produced and opened by PR.

## Evidence
- Tasks: 48bc1923a4fd4541 (this intake) · Head: 5b4c68a6 · CI: none (no code).
- Lookups: GitHub REST issue-event-types / issues events / pulls (high); workflow-runs and rate limits (medium).
