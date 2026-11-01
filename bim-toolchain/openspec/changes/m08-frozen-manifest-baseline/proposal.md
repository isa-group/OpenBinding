# Proposal: m08-frozen-manifest-baseline

## Why

ROADMAP M0.8 of OpenBinding. `baseline_core.CHANGED_MANIFESTS` removes `minizinc-csp` from every comparison with the
frozen baseline since its manifest moved to 1.1.1 (`tools/baseline_core.py:129,1371-1376`), so a regression in its
compatibility goes unseen. The living spec's TODO asks to review that exception.

## What changes

- `schema-versioning`: `req~bim-schema-versioning-goldens` goes to revision 2. The live goldens are compared with
  frozen baselines with no engine excluded; minizinc-csp 1.1.1 gets its own frozen baseline
  `golden/bim_baseline_1_1_1` (byte copy of `golden/bim_core/{compat,protocol}.json`, pinned by SHA-256), compared
  with `golden/bim_baseline` by identifier; the 65 `minizinc-csp` moves are pinned in
  `golden/bim_baseline_1_1_1/minizinc_moves.json`. `CHANGED_MANIFESTS` is removed. The tests are in
  `packages/bim-core/tests/test_baseline_equivalence.py` (`test_frozen_manifest_*`).

## Out of scope

- Any `bim_core` source change or version bump; `golden/bim_baseline/**` stays frozen.
- Extending `regen_normalized_metadata.FROZEN` or regenerating the gateway copy of the goldens.
- Editing the living spec; archiving is a later owner-approved task.

## Impact

Tests and goldens only (slice S3 of `docs/agent-work/m08-qacobench-baseline/intake.md` in OpenBinding). The byte copy
is about 3,000 lines, reviewed by checksum.
