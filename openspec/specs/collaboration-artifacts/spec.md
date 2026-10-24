# collaboration-artifacts Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

Organizations (hierarchical), projects, cases and their revisions, project resources, collections, the
organization artifact library (identities, drafts, sealed versions, publications) and public read of projects.
Sources: `docs/ACCESS_POLICY.md`, `docs/VERSIONED_ARTIFACTS.md`; code in `collaboration.py`, `artifacts.py`,
`routes/organizations.py`, `routes/artifacts.py`, `routes/library.py`, `access/public_read.py`.

## Requirements

### Requirement: Private projects are indistinguishable from missing ones
IF a non-member requests a private or missing project, THEN THE gateway SHALL answer `403 organization_forbidden` with the same body (401 if anonymous).

`req~collaboration-artifacts-private-indistinguishable~1`

Evidence: `openbinding-gateway/tests/test_b3_public_read.py::test_denied_reads_look_exactly_like_a_private_project`; `openbinding-gateway/tests/test_b3_public_read.py::test_a_private_project_is_unchanged_for_non_members`; `docs/ACCESS_POLICY.md`

#### Scenario: Guessing a project slug
- **GIVEN** bob is not a member of `acme`
- **WHEN** he requests `acme/secret` (private) and `acme/nothing` (missing)
- **THEN** both answers are 403 `organization_forbidden` with identical bodies

### Requirement: Public read is GET-only and deny-by-default
WHERE a project is `public`, THE gateway SHALL let any caller, anonymous included, use only the GET routes in the public-read matrix and SHALL refuse every other route exactly as for a non-member.

`req~collaboration-artifacts-public-read-matrix~1`

Evidence: `openbinding-gateway/tests/test_b3_public_read.py::test_every_get_route_is_classified_exactly_once`; `openbinding-gateway/tests/test_b3_public_read.py::test_nothing_but_get_is_ever_eligible`

#### Scenario: A new project route is added
- **GIVEN** a developer adds `GET .../projects/{project}/secrets` without classifying it
- **WHEN** the unit suite runs
- **THEN** the route-table test fails

### Requirement: Visitors see only published material
WHILE a caller reads a public project as a visitor, THE gateway SHALL show only frozen reports with a live publication and publications that are not withdrawn.

`req~collaboration-artifacts-visitor-filtering~2`

Evidence: `openbinding-gateway/tests/test_b3_public_read.py::test_reports_are_only_the_frozen_ones_with_a_live_publication`

#### Scenario: Draft report in a public project
- **GIVEN** a public project with one draft report and one frozen published report
- **WHEN** an anonymous visitor lists reports
- **THEN** only the frozen published report is listed

### Requirement: Visitors see only public files and published artifacts
WHILE a caller reads a public project as a visitor, THE gateway SHALL show only files marked public and library artifacts that are published.

`req~collaboration-artifacts-visitor-files-library~1`

Evidence: `openbinding-gateway/tests/test_b3_public_read.py::test_files_are_listed_and_downloaded_only_when_public`; `openbinding-gateway/tests/test_b3_public_read.py::test_the_library_shows_only_published_artifacts_to_visitors`

#### Scenario: Private file in a public project
- **GIVEN** a public project with one private file and one public file
- **WHEN** an anonymous visitor lists files
- **THEN** only the public file is listed

### Requirement: Public read rate limit
WHEN a visitor exceeds `PUBLIC_READ_RATE_PER_MINUTE` public reads in a sliding minute, THE gateway SHALL answer 429 `rate_limit_exceeded` with `Retry-After`, without limiting members.

`req~collaboration-artifacts-public-read-rate~1`

Evidence: `openbinding-gateway/tests/test_b3_public_read.py::test_reads_are_limited_per_caller_and_never_touch_the_sponsor`; `openbinding-gateway/tests/test_b3_public_read.py::test_the_limit_can_be_switched_off`

#### Scenario: Scraping a public project
- **GIVEN** the default limit of 240 per minute
- **WHEN** one anonymous address makes 241 reads within a minute
- **THEN** the 241st read is answered 429 with `Retry-After`

### Requirement: Sealed versions are immutable
WHEN a library draft is sealed, THE gateway SHALL create an immutable version (updates and deletes rejected by the database), idempotent for a retried seal, and SHALL answer 409 when a label is reused for different content.

`req~collaboration-artifacts-sealed-immutable~1`

Evidence: `openbinding-gateway/tests/test_artifact_library.py::test_sealed_versions_are_private_exact_and_sql_immutable`; `docs/VERSIONED_ARTIFACTS.md`

#### Scenario: Updating a sealed version in SQL
- **GIVEN** a sealed version row
- **WHEN** any process issues an `UPDATE` on it
- **THEN** the database rejects the statement

### Requirement: Exact references in case composition
WHEN a case revision is created, THE gateway SHALL resolve each resource by its exact `{namespace, name, version, versionDigest}`, compile against the exact installed contracts, never a nearby release, and materialize an executable snapshot.

`req~collaboration-artifacts-exact-composition~1`

Evidence: `openbinding-gateway/tests/test_artifact_library.py::test_case_composition_closes_exact_resources_without_copying_authority`; `docs/VERSIONED_ARTIFACTS.md`

#### Scenario: Unavailable exact contract
- **GIVEN** a case that pins a Dialect version not installed
- **WHEN** a revision is created
- **THEN** the gateway refuses it instead of compiling with another version

### Requirement: Revision history protected
IF deleting a blob, project or organization would destroy sealed or revisioned elements that depend on it, THEN THE gateway SHALL refuse (e.g. `409 blob_in_use` listing only kinds and counts).

`req~collaboration-artifacts-history-protection~1`

Evidence: `openbinding-gateway/tests/test_collaboration_platform.py::test_sealed_reports_protect_project_and_organization_history`; `openbinding-gateway/tests/test_b1_blob_delete.py`

#### Scenario: Deleting a blob used by a case revision
- **GIVEN** a blob whose digest backs a case revision snapshot
- **WHEN** a project ADMIN deletes it
- **THEN** the gateway answers 409 `blob_in_use` with `{"type": "case_revision", "count": 1}` and no names

## Out of scope

- Roles and owner rules (`auth-roles-entitlements`); studies and reports' analytics (`studies-analysis`).
- Digest resolution across projects (`resolver-verifier`).

## TODO

- Organization hierarchy (cycles refused, sponsor transfer atomic) and project/organization deletion lifecycle.
- Collections (specialised routes still on the earlier model per `docs/VERSIONED_ARTIFACTS.md`).
- Project package export (`/package`) and redaction for VIEWERs.
- Notifications and invitations.
