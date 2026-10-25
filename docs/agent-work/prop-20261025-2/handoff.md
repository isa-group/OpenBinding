# Handoff: prop-20261025-2
- Status: waiting-review (intake done, nothing implemented) · Updated: 2026-10-25
- Branch / head: task/9e84f479839b454a / base f2e18c6f · PR: none

## Goal
Remove the frozen-clock lease race in the gateway's remote-cancel tests by making the shared `lose_the_worker`
helper use the clock the reconciler reads (INTENT O6).

## State (with evidence)
- Race confirmed in the code. `_helpers.py:22,113` stamps the lease with `db.models.utcnow` (real clock), the
  `frozen` fixture patches `jobs.clock.utcnow` (`test_remote_cancel.py:158-162`), and the sweep reads the patched
  clock and skips live leases (`reconciler.py:245,266-268`; `clock.py:27-29,71-80`).
- Affected tests: six in `test_remote_cancel.py` (starting at :678, :701, :719, :756, :781, :797). The
  `test_engine_cancel_contract.py` tests are protected by the PR #42 workaround (:173-182).
- Plan: one slice S1, low risk, test-only, about 30-50 lines. See `intake.md` sections 4-5.

## Decisions
- D1: one slice, no feature flag. Reason: one capability, test files only, well under 300 lines.
- D2: show the race with `frozen.advance(-5)` (the PR #42 technique, `test_engine_cancel_contract.py:264`), not a
  wall-clock sleep. Reason: same clock distance, deterministic, no added wall time.
- D3: the helper calls `clock.utcnow()` through the module (`from openbinding_gateway.jobs import clock`).
  Reason: a direct `from ...jobs.clock import utcnow` binds at import time and misses the monkeypatch.
- D4: S1 also owns `test_engine_cancel_contract.py`. Reason: its comments at :176-178 and :259-261 describe the
  old real-clock stamp and would become wrong. Removing the workaround is recommended (Q1).

## Ruled out
- Widening the lease margin in `lose_the_worker`: this hides the race instead of removing it (proposal
  alternative; `clock.py:11-13` names `jobs.clock.utcnow` as the clock tests control).
- Changing `tests/test_job_leases.py:73-78`: it is a separate helper whose callers (:514, :522) do not freeze time.
- Changing `a_job`'s `created_at`: the RUNNING-with-lease branch never reads it (`reconciler.py:266-272`).

## Open questions and risks
- Q1: drop the PR #42 workaround or only fix its comments. Waiting on the coordinator.
- Q2: OpenSpec change (G1/G2) or a plain task contract. Waiting on the coordinator.
- No CRP needed.
- Risk: the full gateway suite may time out in the sandbox (`docs/agent-work/panel-27-followups/handoff.md:3`).
  Mitigation: the targeted pytest check plus CI.

## Next three steps
1. Coordinator answers Q1/Q2 and writes the S1 task contract with the owned files and the check argv arrays from
   `intake.md` section 4.
2. S1 worker adds the regression test to `test_remote_cancel.py`, runs the red-before check on the base, then
   changes `_helpers.py:111-116` to `clock.utcnow()` and cleans up `test_engine_cancel_contract.py`.
3. Worker runs the targeted pytest, ruff and the full suite through qa_run. Then a low-risk review (reviewer), and
   a PR with a `how_to_review` (G13 n/a).

## Evidence
- Tasks: this intake (planner). Earlier followups: c560d374322a4d9b (debugger), 969d1bcd074042b6 (reviewer),
  `docs/agent-work/flaky-engine-cancel/report.md:72-78`.
- Heads: f2e18c6f · CI: none run for this intake (no registered checks).
