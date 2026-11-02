# Handoff: prop-20261102-2
- Status: waiting-review (intake done; no code, spec or acceptance written) · Updated: 2026-11-02
- Branch / head: task/d57e0060abc54294 / base `5b4c68a6` · PR: none

## Goal
Make `docs/qa/SECURITY_REVIEW.md` a dated register with severity and status per finding, so that O8 ("0 open high
or critical findings at each release to `main`", `INTENT.md:169`) gets a yes or no answer at the R1 gate.

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261102-2/intake.md` (facts F1-F15, slices S1 and optional S2, gates, CRPs).
- Proposal evidence confirmed in the tree:
  - analysis code removed: `tests/test_removed_operations.py:59-61`, `tests/test_worker_queues.py:57`,
    `ROADMAP.md:196,198`;
  - stale rows: `SECURITY_REVIEW.md:18,49`;
  - SPACE wording: `SECURITY_REVIEW.md:42,61` against `ROADMAP.md:138-139`;
  - deferred findings: m08 `handoff.md:1`, m09 `handoff.md:9`.
- Added by this intake:
  - M1 also cites the removed route (`SECURITY_REVIEW.md:22`);
  - open items in `SECURITY.md:42-48` are missing from the register;
  - `JOINT_STATUS.md:156` and `SECURITY.md:44` are stale.
- Not found anywhere: the text and severity of R2-SEC-006/007 and R3-SEC-003/004. The m09 review files record only
  dispositions (`review/round2.md:25-26`, `review/round3.md:11-12`). A lookup of PR #60 found none (low confidence).
- No checks were run. None are registered for this task, and the intake only proposes them.

## Decisions
- One required slice (S1, `docs/qa/SECURITY_REVIEW.md` only) and one optional slice (S2: `SECURITY.md`,
  `docs/qa/JOINT_STATUS.md`). Reason: one capability, about 60-90 lines; S2 removes conflicting "open" lists.
- Risk is low for both: docs only, and no risk area covers these files (`.agentic/project.yaml:105-139`). The S1
  panel adds security-auditor to confirm the severities.
- No feature flag and no interface contract: documentation, nothing at runtime.
- The file path is kept, because `INTENT.md:169` points at it (R11, owner only).

## Ruled out
- Reading PR #60 or #78 through the repo tool: refused for the planner role ("this role cannot use repository
  operations").
- Guessing severities, or the text of the m09 findings: the proposal requires "marked for the owner rather than
  guessed".

## Open questions and risks
- CRP-1: the severity scale, and whether an unrated open row fails O8. Recommended: critical/high/medium/low plus
  "unrated"; an unrated row fails O8 until rated. Waiting on: the owner, via CRP.
- CRP-2: who rates. Recommended: the editor proposes, security-auditor confirms in G11, the owner can override.
  Waiting on: the owner, via CRP.
- CRP-3: the four m09 findings with no text. Recommended: open, "description not recorded", unrated, followed by a
  re-review. Waiting on: the owner, via CRP.
- Risk: the changelog check turns red after any `docs/**` commit (`tools/generate_changelog.py:62`; lesson 2).
  Mitigation: the coordinator regenerates it last.
- Risk: the bim-guard check scans every `.md` (lesson 1). Mitigation: the register cites the M9.6 test files, not
  retired literals.

## Next three steps
1. Coordinator: open the CRP-1/2/3 decision requests from intake §7, and decide Q1 (keep S2) and Q2 (OpenSpec
   tracking or not).
2. Coordinator: write the S1 contract:
   - role: doc-steward;
   - owns: `docs/qa/SECURITY_REVIEW.md`;
   - read-only context and checks: from intake §4 (`bim-guard`, `git diff --check`, `changelog`);
   - panel: reviewer and security-auditor.
3. After S1 merges: S2 (optional), then the changelog regeneration and the followups in intake §8.

## Evidence
- Tasks: d57e0060abc54294 (this intake) · Base head: `5b4c68a6` · CI: none run.
