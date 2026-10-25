# Report: S1, dated flaky-test register

## Written

`docs/qa/FLAKY_TESTS.md`: "Last reviewed: 2026-10-25", the age rule, a register table (E1-E7, columns id, test, first
seen, status, PR, owner, deadline, evidence), the O6 count, a verification-limits note and detail sections for E2-E7.
The E1 analysis is kept unchanged under its own heading. No other file was changed.

## Applied from the coordinator

- E7 recorded as fixed by PR #45 (`9273978d`), with no recorded failure.
- E4 and E5 (the two tests fixed by PR #43) recorded as fixed. E6 is the PR #42 test. The coordinator's message said
  "E5, E6"; the intake numbers the PR #43 tests E4 and E5, so I kept the intake's ids.
- E2/E3: owner and deadline cells read `pending owner decision (crp-flaky-b8-classification)`; not counted toward O6.
- The 0.02 s threshold is written as "chosen by the coordinator, awaiting owner confirmation".

## Could not verify

- No `git` access: every "first seen" is `unknown (no record)`. The only dates in the checked files are the
  2026-10-25 handoff date of prop-20261025-2 and an unrelated 2026-09-04 PyPI date; none dates a first failure.
  Until dates are filled in from `git log`, no entry can be aged against the 7-day target.
- PR numbers and short SHAs of E4-E7 come from the intake and the reports; not checked against history.
- Read directly: `design.md:248-249`, `flaky-b8-probe/report.md:65-67`, and `_helpers.py:111-117` and
  `test_engine_cancel_contract.py:244` (by search). Other line references were copied from the intake and not reopened.
- `git diff --check` was not run (no registered check).
