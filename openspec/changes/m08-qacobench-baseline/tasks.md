# Tasks: m08-qacobench-baseline

Order: S0 → (S1 ∥ S2 ∥ S3) → owner step R. Slices own disjoint files (intake §4).

## 0. Spec (S0)
- [x] 0.1 proposal.md, design.md, this file, deltas for `qacobench-experimentation` and `job-execution`, and the
  bim-toolchain change `m08-frozen-manifest-baseline`.
- [ ] 0.2 G1 for both changes, then G2 (epic review).

## 1. S1 gateway (after CRP-M08-1)
- [ ] 1.1 Tests first: `test_job_error_text.py` 422 → `engine_incompatible`; new `test_job_failure_contract.py`.
- [ ] 1.2 RED (G3).
- [ ] 1.3 `remote.py`, `JOB_FAILURES`, `GatewayBindingResult`, regenerated `docs/openapi.json`, `docs/ERRORS.md`.
- [ ] 1.4 Review (G11).

## 2. S2 QACOBench classification
- [ ] 2.1 Tests first in `test_qacobench.py`: the four scenarios of `incompatible-is-data~2`.
- [ ] 2.2 RED (G3).
- [ ] 2.3 `campaign.py` classification by code; README `:52` sentence. `reference/1.1.1/**` untouched.
- [ ] 2.4 Review (G11).

## 3. S3 bim-toolchain frozen baseline
- See `bim-toolchain/openspec/changes/m08-frozen-manifest-baseline/tasks.md`.

## Archive (later, owner-approved)
- [ ] `qacobench-experimentation` delta after S2; `job-execution` delta together with S1.
- [ ] Re-running as 1.1.2 (CRP-M08-2) is an owner step outside this change.
