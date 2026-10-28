## MODIFIED Requirements

### Requirement: Goldens guard semantics
THE toolchain SHALL compare every compilation, semantic digest, evaluation, negative diagnostic code and location against the committed goldens, SHALL allow only the `toolchain` metadata members to be refreshed by `tools/regen_normalized_metadata.py`, SHALL leave frozen baselines untouched, and SHALL compare the live `compat` and `protocol` goldens with a frozen baseline with no engine excluded, using `golden/bim_baseline_1_1_1` for the minizinc-csp 1.1.1 manifest.

`req~bim-schema-versioning-goldens~2`

Needs: impl, utest

Evidence: `packages/bim-core/tests/test_baseline_equivalence.py::test_the_normalized_goldens_match`; `packages/bim-core/tests/test_frozen_manifest_baseline.py`; `docs/DIGESTS.md`; `packages/bim-core/tests/test_golden_toolchain_metadata.py::test_the_frozen_baselines_were_not_touched`

`golden/bim_baseline_1_1_1/{compat,protocol}.json` are byte copies of `golden/bim_core/{compat,protocol}.json` at
creation, pinned by SHA-256. `baseline_core.CHANGED_MANIFESTS` no longer exists.

#### Scenario: Refreshing goldens after a semantic change
- **GIVEN** a change that alters one evaluation of a corpus package
- **WHEN** someone runs the metadata refresh tool
- **THEN** the golden comparison still fails, because only `toolchain` members may change

#### Scenario: minizinc-csp is compared, not excluded
- **GIVEN** a change that flips one `minizinc-csp` entry of the live `golden/bim_core/compat.json`
- **WHEN** the baseline equivalence tests run
- **THEN** they fail on that entry against `golden/bim_baseline_1_1_1/compat.json`

#### Scenario: The 1.1.1 baseline is pinned
- **GIVEN** one byte changed in `golden/bim_baseline_1_1_1/protocol.json`
- **WHEN** `test_frozen_manifest_baseline.py` runs
- **THEN** it fails because the SHA-256 differs from the pinned value

#### Scenario: The 1.1.1 baseline against the old frozen baseline
- **GIVEN** `golden/bim_baseline_1_1_1` and `golden/bim_baseline`, compared by identifier
- **WHEN** `test_frozen_manifest_baseline.py` runs
- **THEN** every engine other than `minizinc-csp` is identical once `meta-router-csp` is removed
- **AND** the `minizinc-csp` entries that differ are exactly those listed in `tests/data/minizinc_1_1_1_compat_moves.json`
- **AND** no entry with `compatible: true` in `golden/bim_baseline` is `false` in `golden/bim_baseline_1_1_1`

#### Scenario: No exception list left
- **GIVEN** the source of `tools/baseline_core.py` and `test_baseline_equivalence.py`
- **WHEN** they are searched for `CHANGED_MANIFESTS`
- **THEN** there is no match
