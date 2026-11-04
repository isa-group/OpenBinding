# Handoff: prop-20261104-2
- Status: waiting-review (plan for the coordinator; no CRP) · Updated: 2026-11-04
- Branch / head: task branch `task/2bc86c5d6dc64a72` on `42173d76` · PR: none (planning only)

## Goal
Plan P-20261104-2 (O6, maintenance, auto-approved). `docs/qa/FLAKY_TESTS.md` gets "First seen" dates from git,
settled E8/E9 PRs and statuses, correct file:line references and a new "Last reviewed", in time for the owner's E2/E3
review on 2026-11-24. Facts F1-F15, the slice, the checks and the questions are in [intake.md](intake.md).

## State (with evidence)
- Nothing is edited. `FLAKY_TESTS.md:18-24` still reads `unknown (no record)`, `:25-26` "pending PR" and `:3` 2026-10-25.
- The proposal's evidence is confirmed: the deselects are at `.github/workflows/ci.yml:162-180`.
- Three things the proposal missed:
  - The m03 `design.md` was archived to `openspec/changes/archive/2026-10-26-m03-gate-tooling/design.md`. Lines
    248-249 still match, but every `design.md` reference in the register points to a missing path.
  - E6's lines drifted. The E6 test is at `test_engine_cancel_contract.py:233` (register: 228), and the regression test
    at `:249` (register: 244).
  - `ci.yml:103` (register `:42`) is stale too. The comment saying "Nothing else is deselected" is at `ci.yml:165`.
- `tools/flow_metrics.py:139-156` parses the register. It ages only rows whose Status starts with `open`/`deselected`,
  excluding E2/E3 by default, and wants a leading `YYYY-MM-DD` in cell 3. So today O6 reports no aged and no unknown
  entry. Of the dates, only E2/E3's affect O6, and only once they are counted again.
- E8/E9 fixes are in the base (`test_process_probe.py:252,300,468,530`).
- No check was run: none is registered for this task, and its output is two documents.

## Decisions (planner; the coordinator may override)
- One doc-steward slice, risk low, owning only `docs/qa/FLAKY_TESTS.md`. Reason: R0 docs (`.agentic/project.yaml:105-139`
  has no glob for it), and about 25-50 lines.
- No feature flag and no OpenSpec delta. Reason: no behaviour change; rolling back means reverting.
- Date cells start with `YYYY-MM-DD`, and the column order is unchanged. Reason: the parser (`flow_metrics.py:143-152`).
- "First seen" = the UTC commit date of the earliest commit adding a record of the flake, not of the test (intake Q1).

## Ruled out
- Estimating dates without a git record: the file forbids it (`FLAKY_TESTS.md:10-12`).
- Folding this into flow-metrics: that change excludes edits to the register (`openspec/changes/flow-metrics/proposal.md:30`).
- `-G` with alternation in a git check: whether it works depends on git's regex flavour, so check 10 uses path history.

## Open questions and risks
- Q1-Q4 for the coordinator (intake §7): the First-seen rule, develop vs local SHAs, registering the 12 read-only
  checks of intake §4.1, and whether to skip OpenSpec. No CRP.
- Risk: the worktree may lack `origin/develop` (check 11), so the steward could cite local "Complete task" SHAs
  instead of develop's. Mitigation: Q2, and say so in "Verification limits".
- Risk: E8/E9 PR numbers need `pr_get`/`pr_list`, which may be closed to a doc-steward. Mitigation: the pr-steward
  supplies them, or `ci_status` on the squash SHA.
- Risk: an edit breaks the table format and E2/E3 turn `unknown` in the flow-metrics page. Mitigation: check 1 before
  and after.

## Next three steps
1. Coordinator: answer Q1-Q4 and register checks 0-11 of intake §4.1, adjusted if needed.
2. Start S1 (doc-steward): run checks 1, 2 and 3-11, fill the register as in intake §3, run checks 1 and 0 again, and
   cite every date with its SHA and path.
3. Reviewer (low panel), then the pr-steward: PR into develop with `how_to_review`, and the `changelog` check after the
   final `chore(changelog)` commit (lesson 2).

## Evidence
- Planning task on `42173d76`. Facts with file:line are in intake.md §2. No lookups were needed.
- Checks: none registered for this task; none run.
