# Handoff: prop-20261104-3
- Status: waiting-review (intake done; no code, spec or acceptance written) · Updated: 2026-11-04
- Branch / head: task/1186970ccf094836 / base `a8876def` · PR: none

## Goal
A lab test checks that the rows and summary of `docs/qa/SECURITY_REVIEW.md` are well formed and agree with each
other, and `tools/o8_count.py` prints a reproducible O8 verdict (`INTENT.md:169`).

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261104-3/intake.md` (facts F1-F18, slices S1 and optional S2, checks,
  gates, questions Q1-Q5).
- Proposal evidence confirmed:
  - the summary is at `SECURITY_REVIEW.md:38-41`;
  - the O8 rule is at `:25-28`;
  - the severities are at `:14-20`;
  - the origin followup is at `prop-20261102-2/intake.md:162-163`.
- Not verifiable in the tree: the task ids `7edfd54eef914e16`, `4090a0db23864f85` and `9ef09b2d4a9f4def` (grep
  finds no match).
- Today the summary matches the rows, by manual count of `:66-93`: 27 open rows (12 low, 2 medium, 1 `>= medium`,
  12 unrated) and none critical or high. The new test should therefore pass on its first run.
- No checks were run. None are registered for this task.

## Decisions
- One required slice: S1, owning `tools/o8_count.py` and `lab/tests/test_security_register.py`. Reason: one
  capability; about 100-140 tool lines, and tests do not count toward the limit (`project.yaml:14`).
- One optional slice: S2, one sentence in the register. It runs after S1.
- Risk is low: no risk area covers these paths (`project.yaml:105-139`), and there is no runtime code, API or
  dependency.
- No new CI job. The `lab` job already runs on every PR (`ci.yml:189-217`, no `if:`), so `.github/**` (R10) stays
  untouched.
- No feature flag and no interface contract.
- No CRP. The tool encodes the owner's existing O8 rule and scale (`SECURITY_REVIEW.md:10-12,25-28`) and changes
  neither.

## Ruled out
- Splitting severity on whitespace or matching bare tokens. The cells carry parentheticals (`:48,66,67,69,72,84,86`),
  and one id contains a space (`:93`).
- Matching the summary line by line. It wraps over `:38-41`, so the paragraph must be joined first.
- Generating the summary with a `--write` mode. It is a larger change, and the proposal asks for a check.
- Registering `python3 tools/o8_count.py` as a must-pass check. Under the recommended exit codes it exits 1 today.

## Open questions and risks
- Q1 exit codes. Recommended: 0 met, 1 not met, 2 malformed. Waiting on: coordinator.
- Q2 summary grammar. Recommended: the test matches the existing sentences, and a reword fails on purpose. Waiting on:
  coordinator.
- Q3 OpenSpec change `security-register-check` with 3 requirements. Recommended: yes. Waiting on: coordinator.
- Q4 keep S2. Recommended: yes. Waiting on: coordinator.
- Q5 sequencing with nightly P1 (rate the 12 unrated rows). Whichever merges second must keep, or teach the test, the
  summary grammar. Waiting on: coordinator.
- Risk: the changelog check turns red after any commit (lesson 2). Mitigation: the coordinator regenerates it last.
- Risk: `bim-guard` scans every file (lesson 1). Mitigation: the new files name no retired marker. Run check 4.

## Next three steps
1. Coordinator: decide Q1-Q5 and, if Q3 is yes, write the OpenSpec change `security-register-check` with the three
   requirements from intake §7.
2. Coordinator: write the S1 implementer contract:
   - owned files: `tools/o8_count.py`, `lab/tests/test_security_register.py`;
   - read-only context: intake §4;
   - checks 1-6 of intake §4, with check 1 as red-before on the base;
   - panel: `[reviewer]`.
3. After S1 merges: S2 (optional), then the changelog regeneration.

## Evidence
- Tasks: 1186970ccf094836 (this intake) · Base head: `a8876def` · CI: none run.
