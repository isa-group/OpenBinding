# instances-snapshots Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

How the gateway accepts BIM v1 packages, validates and compiles them through the BIM port, and stores immutable,
owner-scoped snapshots (`POST /v1/instances`, `POST /v1/validate`, `POST /v1/instances/validate`,
`GET /v1/instances/{id}[/source|/ir]`, `GET /v1/snapshots/{id}[/archive]`). Language semantics belong to the BIM
toolchain specs (`bim-toolchain/openspec/specs/`).

## Requirements

### Requirement: Packages only as ZIP archives
WHEN a client uploads a package, THE gateway SHALL accept only a complete `.bim.zip` (raw ZIP media type or a multipart part) and SHALL answer 415 for any other media type before reading size limits.

`req~instances-snapshots-zip-only~1`

Evidence: `openbinding-gateway/tests/test_instances_service.py::test_an_upload_must_use_a_zip_media_type_before_any_limit_is_read`; `openbinding-gateway/tests/test_v1_platform_contracts.py::test_jobs_reject_json_packages_in_favour_of_snapshots_or_zip`

#### Scenario: JSON instead of a ZIP
- **GIVEN** a client that posts `instance.json` as `application/json`
- **WHEN** it calls `POST /v1/instances`
- **THEN** the gateway answers 415 and stores nothing

### Requirement: Hostile archives refused
IF an uploaded archive exceeds the package limits (size, entry count, expansion ratio) or uses an entry type other than stored or deflated, THEN THE gateway SHALL answer 413 or 422 with a problem document without inflating beyond the limit.

`req~instances-snapshots-hostile-archives~1`

Evidence: `openbinding-gateway/tests/test_package_bomb.py::test_a_deflate_bomb_declaring_a_small_size_is_a_422`; `openbinding-gateway/tests/test_package_bomb.py::test_bzip2_and_lzma_entries_are_a_422`; `openbinding-gateway/tests/test_v1_package_security.py`

#### Scenario: Deflate bomb with a lying header
- **GIVEN** a ZIP whose entry declares 1 KiB but inflates to 1 GiB
- **WHEN** it is uploaded
- **THEN** the gateway answers 422 and stops inflating at the limit

### Requirement: Compilation diagnostics
IF the BIM toolchain refuses a package, THEN THE gateway SHALL answer 422 with a problem document whose diagnostics carry the toolchain's codes, the resource, the JSON Pointer and, when known, the source span.

`req~instances-snapshots-compile-diagnostics~1`

Evidence: `openbinding-gateway/tests/test_b4_problem_schema.py::test_a_bim_package_the_compiler_refuses_is_a_422_problem_with_its_diagnostics`; `openbinding-gateway/tests/test_b8_range_refusal_pointer.py`

#### Scenario: Unknown candidate reference
- **GIVEN** a package whose constraint references a candidate that does not exist
- **WHEN** it is validated
- **THEN** the gateway answers 422 with a diagnostic naming the resource file and pointer of the reference

### Requirement: Owner-scoped snapshot deduplication
WHEN an account creates a snapshot of a package it already stored with the same package and compilation digests, THE gateway SHALL return the existing snapshot; WHEN another account uploads the same package, THE gateway SHALL create an independent snapshot for it.

`req~instances-snapshots-owner-dedup~1`

Evidence: `openbinding-gateway/tests/test_instances_service.py::test_the_same_package_uploaded_twice_by_its_owner_is_one_snapshot`; `openbinding-gateway/tests/test_instances_service.py::test_the_same_package_uploaded_by_two_accounts_is_two_independent_snapshots`; `openbinding-gateway/src/openbinding_gateway/services/snapshots.py`

#### Scenario: Same package, two accounts
- **GIVEN** alice and bob upload byte-identical packages
- **WHEN** both call `POST /v1/instances`
- **THEN** each receives a different snapshot id and neither can read the other's snapshot

### Requirement: Snapshot visibility
WHEN a caller reads a snapshot, its source, IR or archive, THE gateway SHALL serve it only to its owner or to a member of an organization the snapshot is shared with through a case, and SHALL answer 404 to anyone else exactly as for a snapshot that does not exist.

`req~instances-snapshots-visibility~1`

Evidence: `openbinding-gateway/tests/test_instances_service.py::test_another_account_cannot_read_the_snapshot_in_any_form`; `openbinding-gateway/tests/test_instances_service.py::test_validating_a_snapshot_of_another_account_is_not_found`; `openbinding-gateway/tests/test_viewer_read_only.py::test_a_user_of_another_organization_gets_the_same_404_as_for_a_missing_snapshot`

#### Scenario: Reading another account's IR
- **GIVEN** a snapshot owned by alice and not shared
- **WHEN** bob calls `GET /v1/instances/{id}/ir`
- **THEN** the gateway answers 404 with the same body as for an unknown id

### Requirement: Toolchain pin of stored IR
IF a stored snapshot was compiled by a toolchain whose `compilerDigest` differs from the installed one, THEN THE gateway SHALL refuse to launch jobs on it or serve its IR with a stable 422 problem (`snapshot_not_recompilable` / `contract_not_installed`) and SHALL NOT reinterpret the stored IR.

`req~instances-snapshots-toolchain-pin~1`

Evidence: `openbinding-gateway/tests/test_ir_cutover.py::test_a_launch_on_a_snapshot_of_another_toolchain_is_a_stable_422_and_stores_nothing`; `openbinding-gateway/tests/test_ir_cutover.py::test_over_http_a_stale_snapshot_and_an_old_job_answer_422_never_500`; `docs/qa/SNAPSHOT_INVALID_INSTANCE.md`

#### Scenario: Snapshot from the previous IR order
- **GIVEN** a snapshot compiled by bim-core 0.1.x and a gateway running 0.2.0
- **WHEN** a member launches a job on it
- **THEN** the gateway answers 422 and stores no job

### Requirement: Plan complexity limit
WHEN a package's binding space exceeds the complexity limit of the caller's plan, THE gateway SHALL refuse validation and job submission with a problem document before running any engine.

`req~instances-snapshots-plan-complexity~1`

Evidence: `openbinding-gateway/tests/test_v1_platform_contracts.py::test_validate_and_solve_refuse_instance_exceeding_plan_complexity`; `openbinding-gateway/src/openbinding_gateway/access/policy.py`

#### Scenario: Oversized binding space on the basic plan
- **GIVEN** a plan whose complexity limit is lower than the package's candidate count product
- **WHEN** the caller validates the package
- **THEN** the gateway refuses with a problem document and no job is created

## Out of scope

- BIM language semantics, compile rules and digests (BIM toolchain specs).
- Cases, resources and collections that reference snapshots (`collaboration-artifacts`).

## TODO

- Specify `POST /v1/validate` (authenticated, compatible engine modes in the answer) vs `POST /v1/instances/validate` (anonymous) precisely.
- Snapshot recompilation tool (`tests/test_snapshot_recompile.py`) and the residual "stale snapshots of other owners" (JOINT_STATUS) as maintenance behaviour.
- Registered resources and custom dialect publication (`/v1/resources`, `/v1/dialects`).
