# Handoff: prop-20261025-3
- Status: register merged (PR 46); E2/E3 classified by the owner; first-seen dates and the 0.02 s confirmation open · Updated: 2026-10-25
- Branch / head: task/3b3fc6c20c364d57 / base 2bed6fbf · PR: none

## Goal
Make INTENT O6's "no flaky test older than 7 days" (`INTENT.md:167`) measurable by turning `docs/qa/FLAKY_TESTS.md`
into a dated register.

## State (with evidence)
- The register now exists in `docs/qa/FLAKY_TESTS.md` with entries E1-E7 (PR 46). Still open: the "First seen" dates
  (to be filled from `git log`) and the owner's confirmation of the 0.02 s threshold. E2/E3 are classified: the owner
  chose `runner-measurement` in `crp-flaky-b8-classification` (2026-10-25), so they are runner-CPU measurements, owner
  = the project owner, review date 2026-11-24, not counted toward O6.
- The register at base had one undated entry (`docs/qa/FLAKY_TESTS.md:3-34`).
- There are seven entries to record, E1-E7 (`intake.md` section 2): LibArtifact (fixed), two B8 tests deselected in CI
  (`ci.yml:100-110`), two healthz tests fixed by PR #43 (`f2e18c6f`), the cancel-contract test fixed by PR #42
  (`716f8d13`), and the six remote-cancel tests of the P2 race.
- The P2 race the proposal lists as open is already fixed by PR #45 (`9273978d`):
  `tests/analysis_b3_b4_b6/_helpers.py:111-117` uses `clock.utcnow()`, with a regression test at
  `test_remote_cancel.py:701`.
- Plan: one slice S1 on `docs/qa/FLAKY_TESTS.md`, low risk, about 60-120 lines (`intake.md` sections 4-5).

## Decisions
- D1: one slice and no flag. Reason: one doc file, one capability, under 300 lines.
- D2: "first seen" = the earliest record in the repository (commit date). Reason: earlier CI history is not
  available to the writer, and dates must not be guessed (`unknown (no record)` otherwise).
- D3: add a deadline column. Reason: `TESTING.md:112` requires an owner and a deadline for every quarantine; the
  proposal's columns had no deadline.
- D4: keep the existing LibArtifact analysis verbatim as a detail section. Reason: it is the evidence for E1.
- D5: record E7 as fixed, with no recorded failure. Reason: no CI failure of those tests is recorded in the repo.

## Ruled out
- Removing the `--deselect` options or adding an age check to CI: these change CI (`.github/**`, R10), which is
  outside a docs proposal.
- Reading PR merge dates through the repo tool: the planner role cannot use it ("this role cannot use repository
  operations"). The intake proposes `git log` evidence checks instead.

## Open questions and risks
- CRP-1 (`crp-flaky-b8-classification`): answered 2026-10-25, option `runner-measurement` (see State).
- Open: the 0.02 s skip threshold of the PR 43 tests still awaits the owner's confirmation.
- Q1 (E7 one row or six) and Q2 (`project.yaml:102` cites "INTENT O4" for the 7-day threshold, but O4 is
  reproducibility, `INTENT.md:165`). Waiting on the coordinator.
- Risk: no registered check yields dates. Mitigation: register the evidence checks 1-4 of `intake.md` section 4.
- Risk: dated rows show E2/E3 older than 7 days at once. That is expected, and CRP-1 settles how they count.

## Next three steps
1. Fill the "First seen" cells from `git log` (the cells read `unknown (no record)` today), then age each entry
   against the 7-day target.
2. Get the owner's confirmation of the 0.02 s skip threshold of the PR 43 tests, or a different value.
3. Answer Q1/Q2 if still open; on 2026-11-24 review E2/E3 again.

## Evidence
- Tasks: this intake (planner, no checks registered or run). Related: P-20261025-2 (`docs/agent-work/prop-20261025-2/`).
- Heads: 2bed6fbf · CI: none run for this intake.
