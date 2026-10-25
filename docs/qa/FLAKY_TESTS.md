# Flaky tests

Last reviewed: 2026-10-25

Register of known flaky, quarantined (deselected) and recently fixed tests. It serves INTENT O6, "no flaky test older
than 7 days" (`INTENT.md:167`), and the quarantine rule "only through this file with an owner and a deadline"
(`TESTING.md:112`).

**Age.** An entry with status `open` or `deselected` is older than 7 days when today minus "First seen" is more than
7 days. "First seen" is the date of the earliest record in this repository (a committed document with a date). Earlier
CI history is not available to the writer, so where no dated record exists the cell reads `unknown (no record)` and no
date is estimated. An entry with an unknown date cannot be aged until a date is found.

## Register

| ID | Test | First seen | Status | PR | Owner | Deadline | Evidence |
|---|---|---|---|---|---|---|---|
| E1 | `frontend/src/pages/Library/LibArtifact.test.tsx` · "starts a draft from a sealed version, keeping its content and links" | unknown (no record) | fixed | none recorded | n/a | n/a | `docs/qa/FLAKY_TESTS.md` (section E1 below) |
| E2 | `bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_evidence.py::test_the_throughput_cost_of_a_short_switch_interval` | unknown (no record) | deselected in the `bim-toolchain` CI job | none | the project owner | 2026-11-24 | `.github/workflows/ci.yml:100-110`; `test_analysis_b8_evidence.py:128`; `openspec/changes/m03-gate-tooling/design.md:248` |
| E3 | `bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_probe.py::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]` | unknown (no record) | deselected in the `bim-toolchain` CI job | none | the project owner | 2026-11-24 | `.github/workflows/ci.yml:100-110`; `test_analysis_b8_probe.py:213-214,232,263`; `design.md:248` |
| E4 | `.../analysis/test_analysis_b8_probe.py::test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load` | unknown (no record) | fixed | #43 (`f2e18c6f`) | n/a | n/a | `test_analysis_b8_probe.py:140,201-202`; `docs/agent-work/flaky-b8-probe/report.md:1-79` |
| E5 | `bim-toolchain/packages/bim-service/tests/test_execution_in_the_pool.py::test_healthz_stays_responsive_under_cpu_load_with_the_configured_interval` | unknown (no record) | fixed | #43 (`f2e18c6f`) | n/a | n/a | `test_execution_in_the_pool.py:506,561-562`; `flaky-b8-probe/report.md:8-10,32-34` |
| E6 | `openbinding-gateway/tests/test_engine_cancel_contract.py::test_the_credential_of_another_tenant_cannot_stop_the_job_and_the_404_is_not_retried` | unknown (no record) | fixed | #42 (`716f8d13`) | n/a | n/a | `test_engine_cancel_contract.py:228,244-247`; `docs/agent-work/flaky-engine-cancel/report.md:1-70`; `design.md:249` |
| E7 | Six `frozen` + `lose_and_sweep` tests in `openbinding-gateway/tests/test_remote_cancel.py` (the "P2 race") | unknown (no record); no CI failure of these tests is recorded | fixed | #45 (`9273978d`) | n/a | n/a | `openbinding-gateway/tests/analysis_b3_b4_b6/_helpers.py:111-117`; `test_remote_cancel.py:701`; `docs/agent-work/prop-20261025-2/report.md:1-26` |
| E8 | `openbinding-gateway/tests/test_process_probe.py::test_the_timeout_step_sees_the_503_the_healthz_and_the_next_request` | 2026-10-25 (first push-triggered CI run on develop, `5cf72550`, job `test`) | fixed in this change, pending the next develop push run | pending PR (fix commit on branch task `d0035241`) | n/a | n/a | section E8 below |
| E9 | `openbinding-gateway/tests/test_process_probe.py::test_the_whole_probe_passes_against_worker_processes_with_the_n2_figures` | 2026-10-25 (CI run of PR 51, job `test`; passed on develop at `7707a532` and on PR 50) | fixed in this change, pending CI | pending PR (fix commit on branch task `a8b3a4fa`) | n/a | n/a | section E9 below |

**O6 status.** E2 and E3 (the two tests deselected in the `bim-toolchain` CI job) are classified as measurements that
depend on the CI runner's CPU, not as correctness tests. Owner: the project owner. Review date: 2026-11-24 (30 days,
proposed by the planner and accepted by the owner's choice). They are not counted toward O6. This is the owner's
decision, option `runner-measurement` of `crp-flaky-b8-classification` (2026-10-25). Until the "First seen" dates are filled from git history, no entry can be aged against
the 7-day target.

**Verification limits.** This update was written without `git`. Dates, merge commits and PR numbers come only from
the files cited; the PR numbers and short SHAs of E4-E7 are taken from the intake of this change
(`docs/agent-work/prop-20261025-3/intake.md`) and from the reports it cites, and were not checked against the history.

## Details

### E2, E3 · two B8 timing tests deselected in the `bim-toolchain` job

`.github/workflows/ci.yml:100-110` deselects both (`--deselect`; these are the only deselects, as `ci.yml:103` says).
E2 is a throughput ratio that depends on the runner's CPU (47.6 % against a 50 % bound). E3 is a strict xfail (an open
defect) that XPASSes on the runner. Both still run in the toolchain's own CI. Removal condition, from
`design.md:248`: "when the toolchain makes its B8 timing tests robust". Classification: runner-CPU measurements, not
correctness tests, and not counted toward O6 (owner's decision, `crp-flaky-b8-classification`, option
`runner-measurement`, 2026-10-25). Owner: the project owner. Review date: 2026-11-24.

### E4, E5 · healthz under CPU load, fixed in PR #43

Both compared `/healthz` latency with an absolute bound. They now compare with a same-run baseline
(`best_short <= 1.5 * best_default`) and call `pytest.skip` when the default median is below 0.02 s. The 0.02 s
threshold was chosen by the coordinator, awaiting owner confirmation (`docs/agent-work/flaky-b8-probe/report.md:65-67`).
Test names are unchanged.

### E6 · cancel contract, fixed in PR #42

Failed once in CI on a gateway file the change did not touch (`design.md:249`). Fixed in PR #42 with the regression
test `test_a_slow_setup_behind_the_frozen_clock_still_gets_its_lost_attempt_cancelled`
(`test_engine_cancel_contract.py:244`). See `docs/agent-work/flaky-engine-cancel/report.md`.

### E7 · remote cancel, the "P2 race"

The six tests in `test_remote_cancel.py` that combine `frozen` and `lose_and_sweep` shared one cause: the lost-worker
lease did not follow the controlled clock. `lose_the_worker` now reads `clock.utcnow()`
(`tests/analysis_b3_b4_b6/_helpers.py:111-117`), fixed in PR #45 (`9273978d`), with a regression test at
`test_remote_cancel.py:701`. No CI failure of these tests is recorded in the repository, so no first-seen date is given.

### E8 · process probe, timeout step

**First seen.** 2026-10-25, the first push-triggered CI run on develop (commit `5cf72550`, job `test`). The replacement
`validate` got `503 operation_timeout` after 1564 ms against a 0.5 s budget. The test passed on PR runs.

**Classification.** Test-only timing race, no product defect. The thread executor cannot cancel a thread, which is its
documented behaviour.

**Cause (inferred from code and timings, not reproduced).** After the 503 the abandoned neighborhood threads stay alive.
When the patched `sleep(1.5)` ends they compute the real operation (parse the IR, up to 128 alternatives) while the
replacement requests run and, on a slow runner, starve the event loop.

**Fix.** The helper `stuck_neighborhood` in `openbinding-gateway/tests/test_process_probe.py` blocks the abandoned
threads on a `threading.Event`, released in a `finally` after the probe, so nothing computes. The 0.5 s budget,
`--hold 0.2` and all assertions are unchanged; no threshold was raised and the test is not skipped. The fix commit is on
the branch of task `d0035241` (PR: pending PR).

**Verification.** The target test passed 5 of 5 repeated runs in the lab check environment. The lab Python has no
`os.pidfd_open`, so the two worker-process tests of the file
(`test_the_probe_runs_its_non_costly_scenarios_against_worker_processes` and
`test_the_whole_probe_passes_against_worker_processes_with_the_n2_figures`) cannot run there and are verified only by CI.

**Status.** Fixed in this change, pending the next develop push run.

**Not changed.** The cold first `validate` of the demo package is still measured against 0.5 s. No warm-up was added,
since it did not fail.

### E9 · process probe, whole probe against worker processes

**First seen.** 2026-10-25, CI run of PR 51 (a frontend-only change, head `8fbc35af`), job `test`: 1 failed, 3145 passed.
The same test passed on develop at `7707a532` and on PR 50. The text of the failed assertion was not recoverable from the
log. These facts and the log lines below come from the request that opened this fix, which read them from that CI run;
they are not in a committed document.

**Classification.** Test-only timing flake of the same family as E8, no product defect. The service behaved as designed
in the captured log.

**Evidence.** The captured service log around the end of the failed run (process executor, `operation_timeout_seconds`
3.0, concurrency 2): `POST /bim/v1/neighborhood` answered 200 at 1251-1273 ms, 1719 ms, 2545 ms, 2921 ms and 3028 ms,
503 at 2001 ms (twice) and at 3006 ms, and one more 200 at 259 ms; `/healthz` stayed at 0.3-0.5 ms; the last `validate`
was 200 at 38 ms.

**Cause (inferred from code and timings, not reproduced).** In this test every costly request is the real
`/neighborhood` operation, whose duration is whatever the runner makes of it. The checks of the probe
(`openbinding-gateway/tools/process_probe.py`) and of the test whose outcome depends on it:

- timeout step: the ladder (`calibrate`, line 1258) stops at the first 503 `operation_timeout`, and that same body is sent
  again as the request over the budget (`step_timeout_replacement`). Checks: "a valid request that lasts longer than the
  time budget could be built within the body cap" (1449; a fast runner may not pass 3 s within the 0.9 x 2 MiB cap),
  "the request over the budget: 503 operation_timeout" (1483), "it ends in about the time budget" (1484; 2.7 to 6.0 s
  with the worker start counted, and the test's own `3.0 * 0.9 <= requestSeconds <= 6.0`), and the `/healthz` and
  parallel-request checks during it. The first three hold only if the repeated body lasts longer than the budget again;
  the ladder takes one 503 as proof, with no margin, and the size of its last rung is extrapolated from one earlier
  measurement of the same runner;
- saturation: "a costly valid request could be built" (1339), "no unexpected answer" (1351; any 503 `operation_timeout`
  fails it), "some are refused" and "some requests are served" (1352-1353; they follow from the request lasting
  longer than the 2 s slot wait on 2 slots and shorter than the budget);
- load: "a costly valid request could be built" (1367), "the load really ran" (1422), "no unexpected answer to the load"
  (1423) and the `/healthz` p95 and max checks (1419-1420). The `/healthz` checks are not the cause here: 0.3-0.5 ms
  against 2000 ms and 5000 ms.

Most likely failed: "the request over the budget: 503 operation_timeout" (`process_probe.py:1483`). Reasoning: the
ladder aims at a request of 1.15 x 3.9 s = 4.5 s and stops at the first 503, so the one 503 at 3006 ms in the log is a
ladder rung or the repeated request, and a passing run has both; the budget starts at the first write to the worker
(`workers.py:847-851`), so waiting for a slot does not count and a load request (about 1.25 s alone) would need 3 s of its
own to fail the saturation or load checks. A repeated request that ends under 3 s as a 200 (2921 ms and 3028 ms are in the
log) fits that. Confidence: moderate (about 50 %); the log lines are a selection and carry no request order, so the two
`no unexpected answer` checks (a request stretched 2.4 times on a loaded runner, the workers run at `nice` 10) stay as
the alternative, and in every case the cause is the duration of the costly requests on a slow runner. The check of the
epoch marks against the monotonic clock (10 ms) at the end of the test is a lower-probability candidate: it fails only if
the wall clock is slewed during the run; it is left as it is. The replacement checks are not the cause (`validate` 200
at 38 ms).

**Fix.** Only `openbinding-gateway/tests/test_process_probe.py`. The worker processes of this test preload a module
(`worker_preload`, written to `tmp_path` by `slow_workers`) that makes the costly request of the probe (`limit` 128) busy
for `len(binding) * 5 ms`, counted from the start of the operation, instead of computing 128 evaluations; the route, the
limits, the answer shape and the process executor are the real ones, and any request with another `limit` is the real
operation. The duration no longer depends on the runner: the load plan is about 1.1-1.2 s (3 s budget), the ladder of the
timeout step ends at about 850 tasks (4.3 s, 0.9 MB of the 1.8 MB cap) and its repetition over the budget is 503 at 3 s
every time. The work is still CPU-bound, so `/healthz` is still measured against busy workers. No threshold was raised,
no limit of the service changed, the step and the assertions are unchanged and the test is not skipped. A new test,
`test_the_workers_of_the_costly_request_keep_it_busy_for_as_long_as_its_size_says`, starts a real worker process the way
the pool does and checks that the preloaded module is in effect (it runs in the lab). The probe itself
(`tools/process_probe.py`) is not changed. Not changed there, for a follow-up: the ladder takes a single 503 as proof
that the body lasts longer than the budget, without a margin.

**Verification.** Only by the CI of the PR for the fixed test. The lab Python has no `os.pidfd_open`, so this test and
`test_the_probe_runs_its_non_costly_scenarios_against_worker_processes` cannot run in the lab; the registered check ran the
rest of the file with those two deselected (21 passed, 2 deselected), which includes the new test of the worker module.
The new test checks the mechanism, not the whole probe.

**Status.** Fixed in this change, pending CI.

### E1 · `LibArtifact.test.tsx` · "starts a draft from a sealed version, keeping its content and links"

No date and no PR are recorded for this entry. The analysis below is unchanged.

**Symptom.** Failed once under `vitest run` and passed on rerun. A green rerun is not a fix, so the cause was looked for.

**Reproduced.** Yes, on 2 of 15 runs of the file (`vitest run src/pages/Library/LibArtifact.test.tsx` in a loop), and again on 1 of 15 in a second loop. The failures were always in this test; the other 15 tests in the file never failed. `--sequence.shuffle` over `src/pages/Library` (136 tests) did not fail, so test order is not involved.

**Cause (demonstrated).** The default output filter hid the failing assertion. A temporary wrapper around each assertion after "Create draft" labelled the failure, and the only one that failed in the failing run was the last:

```
expect(screen.getByRole('tab', { name: /^Drafts/ })).toHaveAttribute('aria-selected', 'true')
```

The toast text, `lib.content`, `lib.createDraft` and the "Open the editor" link had all passed before it. The component calls `setTab('drafts')`, which is `setSearchParams`, and then `setToast(...)`. React Router v7 applies the navigation inside `React.startTransition`, while `setToast` is an ordinary update. The toast can therefore commit one render before the router state that selects the tab. `findByText('Draft created from version 3.')` resolves on that first commit, and the synchronous `getByRole('tab')` that follows reads the tab before it has switched. Whether the two commits land together depends on timing, which is why it only failed sometimes.

The cause is in the test, not the component: the user-visible result (toast, then the Drafts tab selected a moment later) is correct. Mocks are reset in `beforeEach`, there are no timers, storage, `Date` or random values involved, and the mocked fetches resolve in a fixed order, so none of those contributed.

**Fix.** In `frontend/src/pages/Library/LibArtifact.test.tsx` the last assertion now waits for the selected tab:

```
expect(await screen.findByRole('tab', { name: /^Drafts/, selected: true })).toBeInTheDocument();
```

It still asserts the same thing (the Drafts tab ends up selected) and the default `findBy` timeout is kept; it only stops assuming the tab commits in the same render as the toast. The component is unchanged.

**Verification.**

- Before the fix: 3 failures in 30 runs of the file, all at the `aria-selected` assertion.
- After the fix: 0 failures in 30 runs of the file (two loops of 15), and `--sequence.shuffle` over `src/pages/Library` passed (9 files, 136 tests). `pnpm lint` and `git diff --check` are clean.
- Not run: the complete frontend suite, because no registered check runs it.
- The rate was low to begin with, so a clean loop is evidence, not proof. The proof is the demonstrated cause above and the removal of the assumption it depends on.

**Not changed.** Other tests in the file click a tab and then read it with a synchronous `getBy`. `fireEvent` runs inside `act`, which flushes the transition before it returns, and none of them failed in 60 runs, so they were left as they are. If one fails, use the same fix: `findByRole(..., { selected: true })`.
