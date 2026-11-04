# Handoff: prop-20261104-1
- Status: waiting-review (intake done; waiting for the coordinator to turn it into a change and task contracts) · Updated: 2026-11-04
- Branch / head: task/bda591af73c643ab / base a8876def · PR: none

## Goal
Every open row of `docs/qa/SECURITY_REVIEW.md` that blocks O8 by default gets a rating proposed from evidence in the
tree. These are the 12 unrated rows and M5-K. The owner then confirms the ratings, so O8 has a yes or no answer before R1.

## State (with evidence)
- Intake written: `docs/agent-work/prop-20261104-1/intake.md`. It holds the facts F1-F22 (checked at `a8876def`), the
  slices S1-S3, the checks, the gates and CRP-A/B.
- The proposal's row lines are confirmed: `SECURITY_REVIEW.md:38-41,66-93`.
- The M4-2 evidence is confirmed, with two corrections:
  - "Every area changed" on a push or manual run is in `tools/ci_changes.py:117-118`. `ci.yml:21` is only a comment.
  - `baseline_core.py --check` fails loudly without the corpus (`:1405-1407`). The pytest corpus tests can still skip
    quietly, because the root workflow does not set `BIM_REQUIRE_CORPUS` (`core_support.py:31-36`).
- New fact for M5-K: `compose.lab-pricing.json:10-11` passes `DEMO_SPACE_MANAGEMENT_KEY` to the remote SPACE.
- m08-SEC-003 still applies to the code (`experimentation/qacobench/campaign.py:248,255`). m09 F7 is still unticked
  (`openspec/changes/m09-compose-only/tasks.md:128-132`).
- No check was run. None is registered for this task.

## Decisions
- One capability, three slices in sequence: S1 ratings, S3 (optional) m09 re-review, S2 owner confirmation. Reason: all
  three write the one file `SECURITY_REVIEW.md`, so they cannot run in parallel.
- Risk is low for every slice. Reason: `docs/qa/**` matches no risk glob (`.agentic/project.yaml:105-139`).
- The G11 panel for S1 and S3 is `[reviewer, security-auditor]`, with a clean auditor who did not author the slice.
  Reason: the kind is security, and an independent auditor checks the floor (`SECURITY_REVIEW.md:18`).
- No feature flag. Reason: documentation only, and each slice is reverted by one commit.

## Ruled out
- Parallel slices per row group: they would share one owned file.
- Closing the rows with no recorded text as "not recoverable": `closed` needs a fix with evidence
  (`SECURITY_REVIEW.md:22`).
- Reading the CI run of `develop` for M4-2 here: the planner role cannot use repository operations (the tool refused).

## Open questions and risks
- CRP-A (owner, after S1): confirm or override each proposed rating. Decide on R2-SEC-006/007, R3-SEC-003/004 and
  LIC-1. Options a-d are in intake §7.
- CRP-B (owner, only if S1 bounds M5-K above medium): fix, rotate and scope the key, or waive it for R1.
- Q1 (coordinator): P-20261103-1 S1 also owns `SECURITY_REVIEW.md` (`prop-20261103-1/intake.md:69,90`) and describes
  its old layout. Serialise the two proposals. Its row goes into the register table.
- Risk: the source followups `7edfd54eef914e16` and `4090a0db23864f85` are not in the tree and were not read. S1
  should get their text from the coordinator.
- Risk: the changelog check is red after any `docs/**` commit until the file is regenerated last (lesson 2).

## Next three steps
1. Coordinator: resolve Q1 (order against P-20261103-1). Then open the S1 contract for the security-auditor. It owns
   only `docs/qa/SECURITY_REVIEW.md`, its context is intake §4 S1, and its checks are intake §4 checks 1-3.
2. S1: rate each row with file:line evidence and read `ci_status` of a recent `develop` push for M4-2. Recompute
   `:38-41`, then list the rows left unrated in the result block.
3. After S1 is merged, raise CRP-A with S1's list. Then run S3 if option b is chosen, and run S2 with the answer.

## Evidence
- Intake facts: `docs/agent-work/prop-20261104-1/intake.md` §2 (F1-F22). Base `a8876def`. No CI run was read and no
  check was run.
