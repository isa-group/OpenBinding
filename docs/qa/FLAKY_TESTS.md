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
| E2 | `bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_evidence.py::test_the_throughput_cost_of_a_short_switch_interval` | unknown (no record) | deselected in the `bim-toolchain` CI job | none | pending owner decision (crp-flaky-b8-classification) | pending owner decision (crp-flaky-b8-classification) | `.github/workflows/ci.yml:100-110`; `test_analysis_b8_evidence.py:128`; `openspec/changes/m03-gate-tooling/design.md:248` |
| E3 | `bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_probe.py::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]` | unknown (no record) | deselected in the `bim-toolchain` CI job | none | pending owner decision (crp-flaky-b8-classification) | pending owner decision (crp-flaky-b8-classification) | `.github/workflows/ci.yml:100-110`; `test_analysis_b8_probe.py:213-214,232,263`; `design.md:248` |
| E4 | `.../analysis/test_analysis_b8_probe.py::test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load` | unknown (no record) | fixed | #43 (`f2e18c6f`) | n/a | n/a | `test_analysis_b8_probe.py:140,201-202`; `docs/agent-work/flaky-b8-probe/report.md:1-79` |
| E5 | `bim-toolchain/packages/bim-service/tests/test_execution_in_the_pool.py::test_healthz_stays_responsive_under_cpu_load_with_the_configured_interval` | unknown (no record) | fixed | #43 (`f2e18c6f`) | n/a | n/a | `test_execution_in_the_pool.py:506,561-562`; `flaky-b8-probe/report.md:8-10,32-34` |
| E6 | `openbinding-gateway/tests/test_engine_cancel_contract.py::test_the_credential_of_another_tenant_cannot_stop_the_job_and_the_404_is_not_retried` | unknown (no record) | fixed | #42 (`716f8d13`) | n/a | n/a | `test_engine_cancel_contract.py:228,244-247`; `docs/agent-work/flaky-engine-cancel/report.md:1-70`; `design.md:249` |
| E7 | Six `frozen` + `lose_and_sweep` tests in `openbinding-gateway/tests/test_remote_cancel.py` (the "P2 race") | unknown (no record); no CI failure of these tests is recorded | fixed | #45 (`9273978d`) | n/a | n/a | `openbinding-gateway/tests/analysis_b3_b4_b6/_helpers.py:111-117`; `test_remote_cancel.py:701`; `docs/agent-work/prop-20261025-2/report.md:1-26` |

**O6 status.** E2 and E3 (the two tests deselected in the `bim-toolchain` CI job) have no owner and no deadline, so
`TESTING.md:112` is not met for them. Whether they count toward O6 is pending the owner's decision
(`crp-flaky-b8-classification`). Until the "First seen" dates are filled from git history, no entry can be aged against
the 7-day target.

**Verification limits.** This update was written without `git`. Dates, merge commits and PR numbers come only from
the files cited; the PR numbers and short SHAs of E4-E7 are taken from the intake of this change
(`docs/agent-work/prop-20261025-3/intake.md`) and from the reports it cites, and were not checked against the history.

## Details

### E2, E3 · two B8 timing tests deselected in the `bim-toolchain` job

`.github/workflows/ci.yml:100-110` deselects both (`--deselect`; these are the only deselects, as `ci.yml:103` says).
E2 is a throughput ratio that depends on the runner's CPU (47.6 % against a 50 % bound). E3 is a strict xfail (an open
defect) that XPASSes on the runner. Both still run in the toolchain's own CI. Removal condition, from
`design.md:248`: "when the toolchain makes its B8 timing tests robust". Owner and deadline: pending owner decision
(`crp-flaky-b8-classification`).

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
