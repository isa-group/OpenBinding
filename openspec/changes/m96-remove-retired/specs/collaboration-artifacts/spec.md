## ADDED Requirements

### Requirement: Project resources are read-only
`req~collaboration-artifacts-resources-read-only~1`
THE gateway SHALL route under `/v1/organizations/{org}/projects/{project}/resources` only `GET /v1/organizations/{org}/projects/{project}/resources` and `GET /v1/organizations/{org}/projects/{project}/resources/{resource}/revisions`.

Needs: impl, utest

#### Scenario: Route table
- **GIVEN** the gateway application built by `create_app`
- **WHEN** the test collects every route whose path template starts with `/v1/organizations/{org}/projects/{project}/resources`
- **THEN** the collected `(method, path template)` pairs are exactly those two

#### Scenario: Existing resource still listed
- **GIVEN** project `p1` of `isa-demo` with resource `r1` and its two revisions, created before this change
- **WHEN** an OWNER calls `GET /v1/organizations/isa-demo/projects/p1/resources` and `GET /v1/organizations/isa-demo/projects/p1/resources/r1/revisions`
- **THEN** the answers are 200, listing `r1` and its two revisions

Evidence: `openbinding-gateway/tests/test_removed_operations.py`; `openbinding-gateway/tests/test_m96_migration.py`

The writes of project resources were retired with the library catalogue (ADR-0020 decision 2). Problem versions and collections replace them.

### Requirement: The organization library is read-only
`req~collaboration-artifacts-library-read-only~1`
THE gateway SHALL route under `/v1/artifacts`, `/v1/organizations/{org}/library` and `/v1/organizations/{org}/projects/{project}/library` only `GET /v1/organizations/{org}/library`, `GET /v1/artifacts/{artifact_id}/versions`, `GET /v1/artifacts/{artifact_id}/versions/{version_id}/content` and `POST /v1/artifacts/resolve`.

Needs: impl, utest

#### Scenario: Route table
- **GIVEN** the gateway application built by `create_app`
- **WHEN** the test collects every route whose path template starts with one of the three prefixes
- **THEN** the collected `(method, path template)` pairs are exactly those four

#### Scenario: Versions still sealed internally
- **GIVEN** an OWNER of `isa-demo` who imports a project package that holds one sealed `Dataset` version
- **WHEN** the client then calls `GET /v1/artifacts/{that artifact's id}/versions`
- **THEN** the answer is 200 and lists that version with its `version_digest`

Evidence: `openbinding-gateway/tests/test_removed_operations.py`; `openbinding-gateway/tests/test_artifact_library.py`

No route creates, renames, drafts, seals, publishes or withdraws a library artifact any more. Package import and the study, collection and case creators seal versions through the internal artifact service, unchanged (design.md §7).

### Requirement: Imported publications need a published version
`req~collaboration-artifacts-import-publication-requires-published~1`
IF a project package declares a publication whose report version has no publication record in the library, THEN THE gateway SHALL refuse the import with 409 `unpublished_import` and create no row of the package.

Needs: utest

#### Scenario: Private report version in a package
- **GIVEN** a package holding a frozen report at a sealed version that was never published, and a publication declaration for it
- **WHEN** an OWNER of the target project imports the package
- **THEN** the gateway answers 409 with `code` `unpublished_import`
- **AND** the target project has no new report, publication or artifact

#### Scenario: Published version in a package
- **GIVEN** a package exported from a project whose report version is published
- **WHEN** an OWNER of another project of the same organization imports it
- **THEN** the import succeeds, and the new publication cites the same version digest

Evidence: `openbinding-gateway/tests/test_artifacts_platform.py`

After this change no operation makes a version public. Package import is then the only creator of `publications` rows, and only for versions that are already public, so a new public release cannot come from it (design.md §7).
