# Tasks: m08-frozen-manifest-baseline

## 0. Spec
- [x] 0.1 proposal.md, this file and the `schema-versioning` delta.
- [x] 0.2 G1 (`openspec validate m08-frozen-manifest-baseline --strict` from `bim-toolchain/`).
- [x] 0.3 Review-round fix (head 3eb175b1): Evidence keeps `test_only_lines_that_hold_a_toolchain_digest_may_differ`;
  `golden/bim_baseline_1_1_1` is protected by the SHA-256 pins, not by `test_the_frozen_baselines_were_not_touched`.

## 1. Slice S3
- [x] 1.1 Tests first: `packages/bim-core/tests/test_baseline_equivalence.py`:
  `test_frozen_manifest_files_have_the_pinned_sha256`, `test_frozen_manifest_is_the_previous_baseline_apart_from_minizinc_csp`,
  `test_frozen_manifest_moves_are_exactly_the_pinned_list`, `test_frozen_manifest_no_compatible_pair_became_incompatible`,
  `test_frozen_manifest_comparison_removes_no_engine`; pinned list `golden/bim_baseline_1_1_1/minizinc_moves.json`.
- [x] 1.2 RED (G3).
- [x] 1.3 Copy `golden/bim_core/{compat,protocol}.json` to `golden/bim_baseline_1_1_1/`; `mismatches()` compares with
  it and no engine removed (`tools/baseline_core.py`); delete `CHANGED_MANIFESTS`; update
  `test_baseline_equivalence.py` and `docs/DIGESTS.md:88-94`. If the "no true became false" check fails, stop and
  report.
- [ ] 1.3a `CHANGELOG.md [Unreleased]` entry (not done in S3: outside its file scope).
- [ ] 1.4 Review (G11).
- [ ] 1.5 Possible follow-up: add `golden/bim_baseline_1_1_1/**` to `tools/regen_normalized_metadata.py` `FROZEN`.

## Archive (later, owner-approved)
- [ ] Archive into `openspec/specs/schema-versioning/spec.md` and close its `CHANGED_MANIFESTS` TODO.
