# Tasks: m08-frozen-manifest-baseline

## 0. Spec
- [x] 0.1 proposal.md, this file and the `schema-versioning` delta.
- [ ] 0.2 G1 (`openspec validate m08-frozen-manifest-baseline --strict` from `bim-toolchain/`).

## 1. Slice S3
- [ ] 1.1 Tests first: `packages/bim-core/tests/test_frozen_manifest_baseline.py` (SHA-256 pins; comparison with
  `golden/bim_baseline` by identifier; no `compatible: true` became `false`), pinned list
  `tests/data/minizinc_1_1_1_compat_moves.json`.
- [ ] 1.2 RED (G3).
- [ ] 1.3 Copy `golden/bim_core/{compat,protocol}.json` to `golden/bim_baseline_1_1_1/`; `mismatches()` compares with
  it and no engine removed; delete `CHANGED_MANIFESTS`; update `test_baseline_equivalence.py`, `docs/DIGESTS.md:88-94`
  and `CHANGELOG.md [Unreleased]`. If the "no true became false" check fails, stop and report.
- [ ] 1.4 Review (G11).

## Archive (later, owner-approved)
- [ ] Archive into `openspec/specs/schema-versioning/spec.md` and close its `CHANGED_MANIFESTS` TODO.
