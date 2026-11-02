# Tasks: m08-qacobench-baseline

Order: S0 → (S1 ∥ S2 ∥ S3) → owner step R. Slices own disjoint files (intake §4). S1 needs the owner's answer to
CRP-M08-1 (option (a) or (c) assumed: the job-level code is literally `engine_incompatible`).

## 0. Spec (S0)
- [x] 0.1 proposal.md, design.md, this file, deltas for `qacobench-experimentation` and `job-execution`, and the
  bim-toolchain change `m08-frozen-manifest-baseline`.
- [x] 0.2 G1 for both changes (`openspec validate --strict`).
- [ ] 0.3 G2 (epic review).
- [x] 0.4 Review-round fix (head 3eb175b1): submission refusal read from the problem document's top-level `code` and
  `diagnostics`; failed job without a code is `ERROR`; `req~job-execution-failure-catalog~2`; archive order.

## 1. S1 gateway (after CRP-M08-1)
- [ ] 1.1 Tests first: `test_job_error_text.py` 422 → `engine_incompatible`; new `test_job_failure_contract.py`.
- [ ] 1.2 RED (G3).
- [ ] 1.3 `remote.py`, `JOB_FAILURES`, `GatewayBindingResult`, regenerated `docs/openapi.json`, `docs/ERRORS.md`;
  re-tag covering code and tests to `req~job-execution-failure-catalog~2`.
- [ ] 1.4 Review (G11).

## 2. S2 QACOBench classification
- [x] 2.1 Tests first in `test_qacobench.py`: the scenarios of `incompatible-is-data~2`.
- [x] 2.2 RED (G3).
- [x] 2.3 `campaign.py` classification by code; README `:52` sentence. `reference/1.1.1/**` untouched.
- [ ] 2.4 Review (G11).
- [x] 2.5 Review-round fix: `campaign.py` reads the submission problem document's top-level `code` and `diagnostics`
  (not `detail.code`), and records a failed job without a code or an error text as `ERROR`; tests for both scenarios.
- [x] 2.6 Round-2 fix: the `detail`-object fallback is removed (a code only inside `detail` is `ERROR`); tests cover
  that case, a code that only shares a prefix, an empty `diagnostics` list, and 429/503 submissions raising.

## 3. S3 bim-toolchain frozen baseline
- See `bim-toolchain/openspec/changes/m08-frozen-manifest-baseline/tasks.md`.

## Archive (later, owner-approved; R1-ARC-001)
- [ ] After CRP-M08-1 is answered and S1 and S2 are merged: archive the `job-execution` and
  `qacobench-experimentation` deltas together, in one task.
- [ ] Re-running as 1.1.2 (CRP-M08-2) is an owner step outside this change. It needs S1: until then a job coded
  `engine_rejected` is recorded `ERROR`, and `campaign.py` raises on `ERROR`, stopping the campaign.
