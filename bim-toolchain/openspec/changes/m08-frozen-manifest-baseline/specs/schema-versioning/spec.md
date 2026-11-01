## MODIFIED Requirements

### Requirement: Goldens guard semantics
THE toolchain SHALL compare every compilation, semantic digest, evaluation, negative diagnostic code and location against the committed goldens, SHALL allow only the `toolchain` metadata members to be refreshed by `tools/regen_normalized_metadata.py`, SHALL leave frozen baselines untouched, and SHALL compare the live `compat` and `protocol` goldens with a frozen baseline with no engine excluded, using `golden/bim_baseline_1_1_1` for the minizinc-csp 1.1.1 manifest.

`req~bim-schema-versioning-goldens~2`

Needs: impl, utest

Evidence: `packages/bim-core/tests/test_baseline_equivalence.py::test_the_normalized_goldens_match`; `packages/bim-core/tests/test_baseline_equivalence.py::test_frozen_manifest_files_have_the_pinned_sha256`; `packages/bim-core/tests/test_baseline_equivalence.py::test_frozen_manifest_is_the_previous_baseline_apart_from_minizinc_csp`; `packages/bim-core/tests/test_baseline_equivalence.py::test_frozen_manifest_moves_are_exactly_the_pinned_list`; `packages/bim-core/tests/test_baseline_equivalence.py::test_frozen_manifest_no_compatible_pair_became_incompatible`; `packages/bim-core/tests/test_baseline_equivalence.py::test_frozen_manifest_comparison_removes_no_engine`; `docs/DIGESTS.md`; `packages/bim-core/tests/test_golden_toolchain_metadata.py::test_the_frozen_baselines_were_not_touched`; `packages/bim-core/tests/test_golden_toolchain_metadata.py::test_only_lines_that_hold_a_toolchain_digest_may_differ`

`golden/bim_baseline_1_1_1/{compat,protocol}.json` are byte copies of `golden/bim_core/{compat,protocol}.json` at
creation. `baseline_core.CHANGED_MANIFESTS` no longer exists. `test_the_frozen_baselines_were_not_touched` covers
only the files of `tools/regen_normalized_metadata.py` `FROZEN` (`golden/bim_baseline/**` and
`golden/ir_previous/evidence.json`), not `golden/bim_baseline_1_1_1`; the new directory is protected by
`test_baseline_equivalence.py::test_frozen_manifest_files_have_the_pinned_sha256` (SHA-256 pins). Adding it to
`regen_normalized_metadata.FROZEN` is a possible follow-up.

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
- **WHEN** `test_baseline_equivalence.py::test_frozen_manifest_files_have_the_pinned_sha256` runs
- **THEN** it fails because the SHA-256 differs from the pinned value

#### Scenario: The 1.1.1 baseline against the old frozen baseline
- **GIVEN** `golden/bim_baseline_1_1_1` and `golden/bim_baseline`, compared by identifier
- **WHEN** `test_baseline_equivalence.py::test_frozen_manifest_is_the_previous_baseline_apart_from_minizinc_csp` runs
- **THEN** every engine other than `minizinc-csp` is identical once `meta-router-csp` is removed

#### Scenario: The minizinc-csp moves are pinned
- **GIVEN** `golden/bim_baseline_1_1_1/minizinc_moves.json`, listing the 65 `minizinc-csp` packages that moved from incompatible to compatible, and the pinned manifest digest
- **WHEN** `test_baseline_equivalence.py::test_frozen_manifest_moves_are_exactly_the_pinned_list` runs
- **THEN** the `minizinc-csp` entries that differ from `golden/bim_baseline` are exactly those listed in `minizinc_moves.json`

#### Scenario: No compatible pair became incompatible
- **GIVEN** `golden/bim_baseline_1_1_1` and `golden/bim_baseline`, compared by identifier
- **WHEN** `test_baseline_equivalence.py::test_frozen_manifest_no_compatible_pair_became_incompatible` runs
- **THEN** no entry with `compatible: true` in `golden/bim_baseline` is `false` in `golden/bim_baseline_1_1_1`

#### Scenario: The comparison removes no engine
- **GIVEN** a changed `minizinc-csp` entry in the live goldens
- **WHEN** `test_baseline_equivalence.py::test_frozen_manifest_comparison_removes_no_engine` runs
- **THEN** `baseline_core` has no `CHANGED_MANIFESTS` attribute
- **AND** `mismatches()` reports the changed entry against `golden/bim_baseline_1_1_1`

#### Scenario: No exception list left
- **GIVEN** the source of `tools/baseline_core.py` and `test_baseline_equivalence.py`
- **WHEN** they are searched for `CHANGED_MANIFESTS`
- **THEN** there is no match
