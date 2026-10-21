# language-compiler Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: OpenBinding `spec/baseline` @ 9b5be00, `bim-toolchain` 0.2.0 — reverse-engineered, spec-anchored. Paths are relative to `bim-toolchain/`.

## Purpose

Loading and compiling BIM v1 packages in `bim-core`: package transport and security (`package.py`), canonical JSON
and digests (`canonical.py`), compilation of an Instance through installed, digest-pinned Profiles and Dialects into
the single IR the Profile declares (`compiler.py`), and the toolchain identity (`toolchain.py`).

## Requirements

### Requirement: Canonical JSON
THE toolchain SHALL serialise JSON in the RFC 8785 canonical form and SHALL refuse non-finite numbers and lone surrogates.

`req~bim-language-compiler-canonical-json~1`

Evidence: `packages/bim-core/tests/test_v1_canonical.py::test_rfc8785_appendix_b_numbers`; `packages/bim-core/tests/test_v1_canonical.py::test_rfc8785_rejects_non_finite_numbers`; `packages/bim-core/tests/test_v1_canonical.py::test_rfc8785_rejects_lone_surrogates_in_keys_and_values`

#### Scenario: NaN in a resource
- **GIVEN** a resource value `NaN`
- **WHEN** it is canonicalised
- **THEN** a `CanonicalizationError` is raised

### Requirement: Safe package loading
WHEN a package is loaded from a ZIP or a directory, THE toolchain SHALL enforce its `Limits` on every dimension, refuse duplicate JSON member names and symlinks, scan the whole XML for forbidden constructs, and validate BPMN offline against the vendored OMG 2.0.2 schema.

`req~bim-language-compiler-safe-loading~1`

Evidence: `packages/bim-core/tests/test_package_security.py::test_limits_apply_to_every_dimension`; `packages/bim-core/tests/test_package_security.py::test_all_input_forms_reject_duplicate_json_names`; `packages/bim-core/tests/test_package_security.py::test_directory_input_rejects_symlinks`; `packages/bim-core/tests/test_package_security.py::test_bpmn_is_validated_against_the_official_offline_omg_schema`; `packages/bim-core/tests/test_package_bomb.py`

#### Scenario: Duplicate member in instance.json
- **GIVEN** an `instance.json` with the key `spec` twice
- **WHEN** the package is loaded
- **THEN** a `PackageError` is raised

### Requirement: Installed, exact contracts only
WHEN an Instance is compiled, THE toolchain SHALL resolve only installed, digest-pinned Profiles, Dialects, schemas and adapters, and SHALL emit the single IR declared by the selected Profile.

`req~bim-language-compiler-installed-contracts~1`

Evidence: `packages/bim-core/tests/test_public_surface.py::test_descriptors_pin_the_installed_manifests`; `packages/bim-core/tests/test_v1_language.py`; `packages/bim-core/src/bim_core/compiler.py`

#### Scenario: Dialect version not installed
- **GIVEN** an Instance that pins a Dialect digest the toolchain does not install
- **WHEN** it is compiled
- **THEN** compilation fails with a diagnostic instead of using another version

### Requirement: Located diagnostics
IF a package does not compile, THEN THE toolchain SHALL raise a `CompileError` whose diagnostics carry a stable code, the resource, a JSON Pointer and, when known, the source span, BPMN element and IR path.

`req~bim-language-compiler-located-diagnostics~1`

Evidence: `packages/bim-core/tests/test_baseline_equivalence.py::test_negative_cases_keep_their_diagnostic_codes_and_locations`; `packages/bim-core/tests/test_b8_range_refusal_pointer.py`

#### Scenario: Malformed range
- **GIVEN** a candidate feature range whose lower bound exceeds its upper bound
- **WHEN** the package is compiled
- **THEN** the diagnostic names the resource file and the pointer of the range

### Requirement: Form-independent IR
WHEN the same canonical package is compiled from a directory, a raw ZIP in any entry order, its canonical ZIP, or with JSON members permuted, THE toolchain SHALL produce byte-identical IR (same `irDigest` and semantic digest), writing IR sets in the canonical order and integral numbers as integers.

`req~bim-language-compiler-form-independent-ir~1`

Evidence: `packages/bim-core/tests/test_zip_dir_equivalence.py::test_the_canonical_zip_is_the_directory`; `packages/bim-core/tests/test_zip_dir_equivalence.py::test_the_order_in_which_a_package_declares_its_objects_has_no_effect_on_the_ir`; `packages/bim-core/tests/test_ir_normalization.py::test_an_integral_float_is_read_as_an_integer`; `packages/bim-core/tests/test_zip_dir_equivalence_corpus.py`

#### Scenario: Catalog keys not in alphabetical order
- **GIVEN** a catalog whose candidates are declared `s2`, `s1`
- **WHEN** the directory and its canonical ZIP are compiled
- **THEN** both IRs list the eligibility `[s1, s2]` and have the same `irDigest`

### Requirement: Toolchain identity
THE toolchain SHALL expose `toolchain_identity()` with name, version, apiVersion, `compilerDigest` and the installed Profiles and Dialects, where `compilerDigest` covers every Python file and every resource of `bim_core` and nothing else.

`req~bim-language-compiler-toolchain-identity~1`

Evidence: `packages/bim-core/tests/test_toolchain_digest.py::test_members_are_every_python_file_and_all_resources`; `packages/bim-core/tests/test_toolchain_digest.py::test_bytecode_and_unrelated_files_do_not_change_the_digest`; `packages/bim-core/tests/test_public_surface.py::test_toolchain_identity_is_json_and_pins_the_bundle_digest`

#### Scenario: One byte of a schema changes
- **GIVEN** an edit of one byte in `resources/schemas/bim/v1/binding-problem.schema.json`
- **WHEN** `compiler_bundle_digest()` is computed
- **THEN** the digest differs from the released one

### Requirement: Pure library
THE `bim_core` package SHALL NOT read environment variables, locate itself in a repository, or import anything but the standard library, `jsonschema`, `lxml`, `yaml` and its own modules, and SHALL reach its resources only through `importlib.resources`.

`req~bim-language-compiler-pure-library~1`

Evidence: `packages/bim-core/tests/test_boundary.py::test_module_imports_only_stdlib_jsonschema_lxml_yaml_and_siblings`; `packages/bim-core/tests/test_boundary.py::test_module_does_not_read_the_environment_or_locate_itself_in_a_repository`; `packages/bim-core/tests/test_settings_and_errors.py::test_from_env_is_pure_and_reads_only_the_mapping`

#### Scenario: Reading BIM_MAX_ENTRIES at import
- **GIVEN** a change that reads `os.environ` in `package.py`
- **WHEN** the boundary tests run
- **THEN** they fail

## Out of scope

- Evaluation, re-evaluation, protocol and compatibility (`evaluator-protocol`).
- Language design of Profiles/Dialects (`docs/BIM_V1.md` in OpenBinding), the corpus (OpenBinding `examples/`).

## TODO

- Expression language (CEL subset) requirements: bounded evaluation is covered in `evaluator-protocol`; syntax and typing not yet specified.
- Registered resources compilation (`RegisteredResource`) and BPMN lowering equivalence with native JSON workflows.
- Port the remaining compile-time tests of OpenBinding's `test_bim_v1_language_final.py` (EXTRACTION_LOG "Missing").
