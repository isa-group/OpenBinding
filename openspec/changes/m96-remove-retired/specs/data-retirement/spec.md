## ADDED Requirements

### Requirement: Export of retired data
`req~data-retirement-export-files~1`
WHEN an operator runs `python tools/export_retired_data.py --out DIR` against a database at Alembic revision `b6c7d8e9f0a1`, the export tool SHALL write into `DIR`, from one read-only transaction, one JSON Lines file per retired-data source, one JSON object per row and line, and then `manifest.json`.

Needs: impl, utest

#### Scenario: Database with retired rows
- **GIVEN** a database at `b6c7d8e9f0a1` with 3 analysis tasks, 1 sponsor proposal and 2 report drafts selected for removal
- **WHEN** the operator runs the tool from `openbinding-gateway/` with `--out` naming a missing directory
- **THEN** the directory holds exactly `analysis_tasks.jsonl`, `sponsor_proposals.jsonl`, `report_drafts.jsonl`, `report_artifact_drafts.jsonl`, `report_artifacts.jsonl`, `report_project_artifacts.jsonl` and `manifest.json`
- **AND** `analysis_tasks.jsonl` has 3 lines, `sponsor_proposals.jsonl` has 1 line and `report_drafts.jsonl` has 2 lines, each line a JSON object whose keys are the table's column names
- **AND** the tool exits with status 0 and prints the absolute path of `manifest.json`
- **AND** every table has the same row count as before the run

#### Scenario: Values in a line
- **GIVEN** a sponsor proposal with id `3f1c…` (a UUID), `status` `pending` and `expires_at` 2026-11-10 12:00 UTC
- **WHEN** the tool exports it
- **THEN** its line has `"id"` as the lowercase hyphenated UUID string, `"status": "pending"` and `"expires_at": "2026-11-10T12:00:00Z"`

#### Scenario: Report draft payload included
- **GIVEN** an unsealed draft of a `Report` artifact selected for removal, whose `payload` is `{"content": {"title": "Q3"}}`
- **WHEN** the tool exports it
- **THEN** its line in `report_artifact_drafts.jsonl` has `"payload": {"content": {"title": "Q3"}}`

#### Scenario: Empty database
- **GIVEN** a database at `b6c7d8e9f0a1` with no row in any of the six selections
- **WHEN** the operator runs the tool
- **THEN** the six files exist and are empty, and `manifest.json` records 0 rows for each

Evidence: `openbinding-gateway/tests/test_export_retired_data.py`

### Requirement: Exported rows are the rows the migration removes
`req~data-retirement-export-selection~1`
THE export tool SHALL write to each of its six files exactly the rows of that file's retired-data selection, ordered by primary key.

Needs: impl, utest

#### Scenario: Selection table
- **GIVEN** a database at `b6c7d8e9f0a1`
- **WHEN** the tool exports
- **THEN** each file holds the rows of its line in the retired-data selection table below, ordered by primary key, and `report_project_artifacts` by `(project_id, artifact_id)`

The retired-data selection table (design.md §6.1):

| File | Rows |
|---|---|
| `analysis_tasks` | every row of `analysis_tasks` |
| `sponsor_proposals` | every row of `sponsor_proposals` |
| `report_drafts` | `reports` rows with `state` `draft`, no sealed version (`version_id` empty), whose artifact has no `artifact_versions` row, and that no `publications` row references |
| `report_artifact_drafts` | unsealed `artifact_drafts` rows of `Report` artifacts that no `reports` row outside `report_drafts` references as its draft |
| `report_artifacts` | `artifacts` rows of kind `Report` with no `artifact_versions` row, no `reports` row outside `report_drafts` and no `artifact_drafts` row outside `report_artifact_drafts` |
| `report_project_artifacts` | `project_artifacts` rows whose artifact is in `report_artifacts` |

#### Scenario: Mixed reports
- **GIVEN** in project `p1` a draft report `d1` without version or publication, a draft report `d2` frozen once at version 1 (never published) and then returned to `draft`, a draft report `d3` published at version 1 and then returned to `draft`, and a frozen report `f1`
- **WHEN** the tool exports
- **THEN** `report_drafts.jsonl` holds `d1` only
- **AND** `report_artifacts.jsonl` holds the artifact of `d1` and not the artifacts of `d2`, `d3` or `f1`

#### Scenario: Draft report whose artifact was sealed through the library
- **GIVEN** a draft report `d4` with `version_id` empty and no publication, whose `Report` artifact received a sealed version through a second draft sealed in the library
- **WHEN** the tool exports
- **THEN** `report_drafts.jsonl` does not hold `d4`, so `GET /v1/resolve/report/{that version's digest}` keeps finding `d4` after the upgrade

#### Scenario: Orphan report draft
- **GIVEN** an unsealed draft of a `Report` artifact that has a sealed version, with no report pointing to the draft
- **WHEN** the tool exports
- **THEN** `report_artifact_drafts.jsonl` holds that draft
- **AND** `report_artifacts.jsonl` does not hold its artifact, because the artifact has a version

#### Scenario: Other kinds untouched
- **GIVEN** an unsealed draft of a `Dataset` artifact and a never-versioned `Dataset` artifact
- **WHEN** the tool exports
- **THEN** neither appears in any file

#### Scenario: Export equals removal
- **GIVEN** a database at `b6c7d8e9f0a1` seeded with every case above, exported with the tool
- **WHEN** `alembic upgrade head` runs with the manifest
- **THEN** the primary keys in each exported file are exactly the primary keys of the rows of that source that no longer exist after the upgrade

Evidence: `openbinding-gateway/tests/test_export_retired_data.py`; `openbinding-gateway/tests/test_drop_retired_data_migration.py`

### Requirement: Export manifest
`req~data-retirement-export-manifest~1`
THE export tool SHALL write `manifest.json` as one JSON object with `format` `openbinding-m96-export/1`, `alembic_head` `b6c7d8e9f0a1`, `exported_at` as the UTC time of the export in ISO 8601 with a `Z` suffix, and under `sources` one entry per file name without extension holding `file`, `rows` (its line count) and `sha256` (the lowercase hexadecimal SHA-256 of the file's bytes).

Needs: impl, utest

#### Scenario: Manifest matches the files
- **GIVEN** an export of a database with 3 analysis tasks
- **WHEN** the test reads `manifest.json`
- **THEN** `sources.analysis_tasks` is `{"file": "analysis_tasks.jsonl", "rows": 3, "sha256": <the SHA-256 of that file>}`
- **AND** `sources` has exactly the six keys `analysis_tasks`, `sponsor_proposals`, `report_drafts`, `report_artifact_drafts`, `report_artifacts`, `report_project_artifacts`
- **AND** `alembic_head` is `b6c7d8e9f0a1`

Evidence: `openbinding-gateway/tests/test_export_retired_data.py`

### Requirement: Export refusals
`req~data-retirement-export-refusals~1`
IF the `--out` directory exists and holds any entry, or the database's Alembic revision is not `b6c7d8e9f0a1`, THEN the export tool SHALL exit with status 2 without creating or changing any file.

Needs: impl, utest

#### Scenario: Directory not empty
- **GIVEN** an `--out` directory that already holds `manifest.json` from an earlier run
- **WHEN** the operator runs the tool again
- **THEN** it exits with status 2 and the earlier `manifest.json` is byte-identical

#### Scenario: Database already migrated
- **GIVEN** a database at the revision of this change, where `analysis_tasks` no longer exists
- **WHEN** the operator runs the tool with an empty directory
- **THEN** it exits with status 2 and the directory stays empty

Evidence: `openbinding-gateway/tests/test_export_retired_data.py`

### Requirement: Migration refuses without a matching export
`req~data-retirement-guard~1`
IF a retired-data selection holds a row when the M9.6 Alembic revision is applied and `OPENBINDING_M96_EXPORT_MANIFEST` does not name a matching export manifest, THEN the revision SHALL raise an error naming the failing check, that variable and `tools/export_retired_data.py` before it changes any table or row.

Needs: impl, utest

#### Scenario: Matching manifest
- **GIVEN** a database at `b6c7d8e9f0a1` with retired rows, and a manifest whose `alembic_head` is `b6c7d8e9f0a1`, whose `rows` equal the current count of every one of the six selections, and whose `sha256` equals the SHA-256 of every named file read from the manifest's directory
- **WHEN** `alembic upgrade head` runs with `OPENBINDING_M96_EXPORT_MANIFEST` naming it
- **THEN** the guard passes and the upgrade proceeds

#### Scenario: No manifest
- **GIVEN** a database at `b6c7d8e9f0a1` with 1 sponsor proposal, and `OPENBINDING_M96_EXPORT_MANIFEST` unset
- **WHEN** `alembic upgrade head` runs
- **THEN** it exits non-zero with a message naming `OPENBINDING_M96_EXPORT_MANIFEST` and `tools/export_retired_data.py`
- **AND** the database is still at `b6c7d8e9f0a1` with the proposal row and `analysis_tasks` present

#### Scenario: Stale counts
- **GIVEN** an export taken with 2 report drafts, after which a third draft report is created
- **WHEN** `alembic upgrade head` runs with the manifest
- **THEN** it exits non-zero with a message naming the source `report_drafts`, and no row or table has changed

#### Scenario: Tampered file
- **GIVEN** a valid export whose `sponsor_proposals.jsonl` has one byte changed afterwards
- **WHEN** `alembic upgrade head` runs with the manifest
- **THEN** it exits non-zero with a message naming the source `sponsor_proposals`, and no row or table has changed

#### Scenario: Missing file or wrong head
- **GIVEN** a valid export whose `report_artifacts.jsonl` was deleted, and separately a manifest whose `alembic_head` is `a0a0a0a0a0a0`
- **WHEN** `alembic upgrade head` runs with each
- **THEN** both runs exit non-zero, and no row or table has changed

Evidence: `openbinding-gateway/tests/test_drop_retired_data_migration.py`; `openbinding-gateway/tests/concurrency/test_m96_migration_pg.py`

### Requirement: Migration needs no export for empty data
`req~data-retirement-guard-empty~1`
WHILE all six retired-data selections are empty, WHEN the M9.6 Alembic revision is applied, the revision SHALL apply without reading `OPENBINDING_M96_EXPORT_MANIFEST`.

Needs: impl, utest

#### Scenario: Fresh database
- **GIVEN** an empty database and `OPENBINDING_M96_EXPORT_MANIFEST` unset
- **WHEN** `alembic upgrade head` runs
- **THEN** it succeeds and the database is at the revision of this change

#### Scenario: Variable names a missing file
- **GIVEN** a database at `b6c7d8e9f0a1` with no row in any selection, and `OPENBINDING_M96_EXPORT_MANIFEST=/nonexistent/manifest.json`
- **WHEN** `alembic upgrade head` runs
- **THEN** it succeeds

Evidence: `openbinding-gateway/tests/test_drop_retired_data_migration.py`

### Requirement: Migration removes exactly the retired data
`req~data-retirement-removed-set~1`
WHEN the M9.6 Alembic revision is applied past its guard, the revision SHALL drop the tables `analysis_tasks` and `sponsor_proposals` and delete exactly the rows of the selections `report_drafts`, `report_artifact_drafts`, `report_project_artifacts` and `report_artifacts`, in one transaction.

Needs: impl, utest

#### Scenario: After the upgrade
- **GIVEN** a database at `b6c7d8e9f0a1` seeded as in the scenarios of requirement "Exported rows are the rows the migration removes", exported with the tool
- **WHEN** `alembic upgrade head` runs with the manifest
- **THEN** the tables `analysis_tasks` and `sponsor_proposals` do not exist
- **AND** report `d1`, its unsealed draft, its artifact and its `project_artifacts` row no longer exist
- **AND** the orphan unsealed draft of the versioned `Report` artifact no longer exists

#### Scenario: A delete fails midway
- **GIVEN** a seeded database and a test hook that makes the deletion of `report_artifacts` fail
- **WHEN** `alembic upgrade head` runs with a valid manifest on PostgreSQL
- **THEN** it exits non-zero
- **AND** every table and row is as it was at `b6c7d8e9f0a1`

Evidence: `openbinding-gateway/tests/test_drop_retired_data_migration.py`; `openbinding-gateway/tests/concurrency/test_m96_migration_pg.py`

### Requirement: Migration keeps everything else
`req~data-retirement-kept-set~1`
WHEN the M9.6 Alembic revision is applied, the revision SHALL leave unchanged every row of every remaining table outside the four deleted selections.

Needs: impl, utest

#### Scenario: Named kept tables
- **GIVEN** a seeded database at `b6c7d8e9f0a1`
- **WHEN** it is upgraded with a valid manifest
- **THEN** every row of `publications`, `artifact_publications`, `artifact_versions`, `artifact_dependencies`, `artifact_evidence`, `case_artifacts`, `binding_case_revisions`, `studies`, `study_runs`, `study_cells`, `project_resources` and their revisions is unchanged
- **AND** so are the `project_artifacts` rows of other artifacts, the unsealed drafts of other kinds, and `organizations.billing_sponsor_user_id`

#### Scenario: Kept rows byte-identical
- **GIVEN** a seeded database at `b6c7d8e9f0a1` with a frozen published report, a draft report with a sealed version, a draft report with a publication, a study with one run, a project resource with two revisions, an unsealed `Dataset` draft and an organization sponsored by alice
- **WHEN** the test dumps every kept table, upgrades with a valid manifest and dumps them again
- **THEN** the two dumps are equal for every kept table
- **AND** the organization is still sponsored by alice

#### Scenario: Kept readers answer the same
- **GIVEN** the same database, read before and after the upgrade by an OWNER of the project
- **WHEN** the client calls `GET /v1/organizations/isa-demo/projects/p1/resources`, `GET .../resources/r1/revisions`, `GET /v1/organizations/isa-demo/library` and `GET /v1/organizations/isa-demo/projects/p1/reports`
- **THEN** the two resource bodies are equal before and after
- **AND** the library list after the upgrade equals the list before it without the deleted `Report` artifact of `d1`
- **AND** the report list after the upgrade equals the list before it without the deleted draft report `d1`

Evidence: `openbinding-gateway/tests/test_drop_retired_data_migration.py`; `openbinding-gateway/tests/test_m96_kept_data.py`; `openbinding-gateway/tests/concurrency/test_m96_migration_pg.py`

### Requirement: Sealed problem versions compile to the same IR
`req~data-retirement-sealed-ir-unchanged~1`
WHEN the M9.6 Alembic revision has been applied, compiling any sealed case revision from its pinned artifact versions SHALL produce the same IR digest as before the upgrade.

Needs: utest

#### Scenario: Case revision recompiled
- **GIVEN** a database at `b6c7d8e9f0a1` with two case revisions that pin sealed resource versions, and the IR digest each compiles to
- **WHEN** the database is upgraded with a valid manifest and each revision is compiled again from its pinned versions
- **THEN** each IR digest equals the one recorded before the upgrade
- **AND** `GET /v1/resolve/case-revision/{digest}` answers 200 with `verified: true` for each, before and after

Evidence: `openbinding-gateway/tests/test_m96_kept_data.py`

The ROADMAP M9.6 acceptance names "every sealed problem version compiles to the same IR". No code that compiles a case is changed by this change, and this test pins that.

### Requirement: Existing publications keep answering
`req~data-retirement-publications-answer~1`
WHEN the M9.6 Alembic revision has been applied, the gateway SHALL answer each existing publication at `GET /v1/resolve/{kind}/{digest_value}`, in the project's publication list and in `GET /v1/explore/publications` with the same document and citation as before the upgrade.

Needs: utest

#### Scenario: Published report
- **GIVEN** a public project `p1` with a frozen report whose version digest `sha256-ab…` has a live publication
- **WHEN** an anonymous visitor calls `GET /v1/resolve/report/sha256-ab…`, `GET /v1/organizations/isa-demo/projects/p1/publications` and `GET /v1/explore/publications` before and after the upgrade
- **THEN** each answer is 200 and its body after the upgrade equals its body before

#### Scenario: Draft report that carries a publication
- **GIVEN** a report published at version 1 and then returned to `draft`
- **WHEN** the database is upgraded
- **THEN** the report, its draft and its publication still exist
- **AND** `GET /v1/resolve/report/{version 1 digest}` answers as before

#### Scenario: Sealed but unpublished report version
- **GIVEN** a report frozen at version 1, never published, then returned to `draft`
- **WHEN** the database is upgraded
- **THEN** a project member's `GET /v1/resolve/report/{version 1 digest}` answers 200 as before

Evidence: `openbinding-gateway/tests/test_m96_kept_data.py`

`/p/{id}` and `/c/{id}` are not implemented (ROADMAP M3.5), so this requirement names the `/v1/resolve` links.

### Requirement: Downgrade recreates empty tables
`req~data-retirement-downgrade~1`
WHEN the M9.6 Alembic revision is downgraded, the revision SHALL recreate `analysis_tasks` and `sponsor_proposals` empty, with the columns, constraints and indexes they had at `b6c7d8e9f0a1`, without restoring any deleted row.

Needs: impl, utest

#### Scenario: Round trip
- **GIVEN** a database upgraded past the M9.6 revision after deleting draft report `d1`
- **WHEN** `alembic downgrade b6c7d8e9f0a1` runs
- **THEN** both tables exist with 0 rows, and the schema of both equals the schema at `b6c7d8e9f0a1`, the partial unique index `uq_sponsor_proposal_pending` included
- **AND** report `d1` does not exist

Evidence: `openbinding-gateway/tests/test_drop_retired_data_migration.py`; `openbinding-gateway/tests/concurrency/test_m96_migration_pg.py`
