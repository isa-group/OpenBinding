# schema-versioning Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: OpenBinding `spec/baseline` @ 9b5be00, `bim-toolchain` 0.2.0 — reverse-engineered, spec-anchored. Paths are relative to `bim-toolchain/`.

## Purpose

How the language contracts (`bim/v1` JSON Schemas, the engine protocol, the IR), the goldens and the three
distributions are versioned, released and kept in step with consumers. Docs: `docs/RELEASING.md`, `docs/DIGESTS.md`,
`docs/GOLDEN_METADATA.md`, `docs/PACKAGING.md`, `CHANGELOG.md`.

## Requirements

### Requirement: One version for three distributions
THE toolchain SHALL give `bim-core`, `bim-service` and `bim-client` one identical version, and the dependents SHALL require `bim-core` by a plain version range.

`req~bim-schema-versioning-one-version~1`

Evidence: `tools/test_packaging_metadata.py::test_the_three_distributions_have_one_version`; `tools/test_packaging_metadata.py::test_dependents_declare_bim_core_as_a_plain_range`

#### Scenario: Bumping only bim-core
- **GIVEN** `bim-core` at 0.3.0 and the others at 0.2.0
- **WHEN** the packaging tests run
- **THEN** they fail

### Requirement: Goldens guard semantics
THE toolchain SHALL compare every compilation, semantic digest, evaluation, negative diagnostic code and location against the committed goldens, and SHALL allow only the `toolchain` metadata members to be refreshed by `tools/regen_normalized_metadata.py`, leaving frozen baselines untouched.

`req~bim-schema-versioning-goldens~1`

Evidence: `packages/bim-core/tests/test_baseline_equivalence.py::test_the_normalized_goldens_match`; `packages/bim-core/tests/test_golden_toolchain_metadata.py::test_the_frozen_baselines_were_not_touched`; `packages/bim-core/tests/test_golden_toolchain_metadata.py::test_only_lines_that_hold_a_toolchain_digest_may_differ`

#### Scenario: Refreshing goldens after a semantic change
- **GIVEN** a change that alters one evaluation of a corpus package
- **WHEN** someone runs the metadata refresh tool
- **THEN** the golden comparison still fails, because only `toolchain` members may change

### Requirement: Previous IR baseline frozen on MAJOR changes
WHEN a MAJOR change alters the IR, THE toolchain SHALL keep the previous baseline as a frozen fixture and record evidence of exactly which packages moved and why.

`req~bim-schema-versioning-previous-baseline~1`

Evidence: `packages/bim-core/tests/test_ir_previous_baseline.py::test_the_frozen_baseline_files_are_not_edited`; `packages/bim-core/tests/test_ir_previous_baseline.py::test_the_normalized_corpus_moved_exactly_where_the_order_of_a_set_changed`; `golden/ir_previous/evidence.json`

#### Scenario: IR order normalisation (0.2.0)
- **GIVEN** the 0.1.x baseline of 82 packages
- **WHEN** 0.2.0 normalises the order of IR sets
- **THEN** the old baseline stays frozen and the evidence lists the packages whose IR moved

### Requirement: Schemas shared byte for byte with the platform
WHILE OpenBinding keeps copies of the `bim/v1` schemas and the engine protocol, THE copies SHALL be byte-identical to the toolchain's, and engine manifests SHALL stay in the platform only.

`req~bim-schema-versioning-schema-parity~1`

Evidence: GAP inside this directory; enforced from the consumer side by OpenBinding's openbinding-gateway/tests/test_bim_schema_parity.py (outside this project root)

#### Scenario: Schema edited only in OpenBinding
- **GIVEN** a change to `schemas/bim/v1/application.schema.json` in OpenBinding only
- **WHEN** the gateway suite runs
- **THEN** the parity test fails

### Requirement: Reproducible releases
WHEN a release is verified, THE toolchain SHALL build every wheel and sdist twice in separate directories with identical SHA-256, install the wheels in a clean venv, run the isolated smoke test, and require the same `compilerDigest` in wheel, sdist, installation and source tree.

`req~bim-schema-versioning-reproducible-release~1`

Evidence: `tools/verify_release.py`; `tools/test_verify_release.py::test_the_report_is_ok_only_if_something_ran_and_everything_passed`; `tools/test_built_artifacts.py::test_the_digest_of_the_wheel_equals_the_digest_of_the_source_tree`

#### Scenario: Timestamp leaks into a wheel
- **GIVEN** a build step that embeds the current time
- **WHEN** `tools/verify_release.py` runs
- **THEN** it reports the differing member and fails

### Requirement: Pinned workflow actions
THE workflows SHALL use only actions pinned to a full commit SHA or explicitly marked `PIN-PENDING` and listed in `licenses.json`, and SHALL publish nothing and read no secret.

`req~bim-schema-versioning-pinned-actions~1`

Evidence: `tools/test_workflows.py::test_every_action_is_pinned_to_a_commit_or_marked_as_pending`; `tools/test_workflows.py::test_workflows_use_no_secrets_and_never_publish_to_an_index`; GAP: all actions are still `PIN-PENDING`

#### Scenario: Unmarked tag reference
- **GIVEN** a workflow step `uses: actions/checkout@v4` without the marker
- **WHEN** the tool tests run
- **THEN** they fail

## Out of scope

- The HTTP path versioning rule of the service (`service-api`, constitution Article 4).
- Publishing channels (index, tags) — not decided.

## TODO

- Release tagging and the pin consumed by OpenBinding (ADR-0004 in OpenBinding).
- Deprecation policy for Profiles/Dialects inside `v1`.
- `toolchain.json` content requirements.
