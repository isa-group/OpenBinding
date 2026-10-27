# Design: m96-remove-retired

Sources:
- `openspec/changes/m24-sunset/` as it stood before this change deleted it (design §2.1, §2.2, §2.3, §7), at the base
  of this change's branch.
- `docs/API_DEPRECATIONS.md`, `docs/adr/0020-smaller-platform.md`, `ROADMAP.md:109,190`.
- The living specs of the eight capabilities.
- The code at the base of this change. File and line references below are to that base.

## 1. Owner decisions

Owner request own-622ca38adc35425586b2be0f895e9b8d, 2026-10-27:

> Sunset now... no hay nada en produccion

As relayed with the task, the decision has three parts:
- The m24-sunset removal gate (a release carrying `Deprecation` and `Sunset`, and a passed Sunset date) is overridden.
- The irreversible data drop is approved with one guard: an export tool is written and tested first.
- The migration refuses to drop non-empty tables until the export has run.

The coordinator approved removing the 5 sponsor-proposal operations B8 to B12 together with the 36 class-A operations.

What follows from it:

- `req~gateway-api-retired-operation-removal-gate~1` and the R1 Sunset procedure (m24-sunset design §5) no longer
  apply. The whole m24-sunset change is superseded (D2).
- No `Sunset` date is ever recorded, and the `Deprecation` signal goes with the operations it announced.
- Data removal is guarded by an export manifest, not by a date (§6).

## 2. The operations

Path templates are FastAPI `path_format` values, as in m24-sunset.

### 2.1 Removed (41)

Status is the answer after removal. "404": the path has no remaining route, so the gateway gives its generic
unrouted answer, today `404` with body `{"detail": "Not Found"}`. "405": the path stays for the method in brackets,
so the gateway gives `405` with an `Allow` header that names only the kept method(s).

| # | Method | Path template | After |
|---|---|---|---|
| 1 | GET | `/v1/analysis/sources` | 404 |
| 2 | POST | `/v1/analysis/query` | 404 |
| 3 | POST | `/v1/analysis/candidate` | 404 |
| 4 | POST | `/v1/analysis/export` | 404 |
| 5 | POST | `/v1/analysis/reports` | 404 |
| 6 | POST | `/v1/analysis/pareto` | 404 |
| 7 | GET | `/v1/analysis/pareto/{task_id}` | 404 |
| 8 | POST | `/v1/analysis/pareto/{task_id}/cancel` | 404 |
| 9 | GET | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| 10 | POST | `/v1/organizations/{org}/projects/{project}/reports` | 405 (GET, B1) |
| 11 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/freeze` | 404 |
| 12 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/drafts` | 404 |
| 13 | PATCH | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| 14 | DELETE | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| 15 | POST | `/v1/organizations/{org}/projects/{project}/publications` | 405 (GET, K2) |
| 16 | POST | `/v1/organizations/{org}/library` | 405 (GET, B2) |
| 17 | GET | `/v1/artifacts/{artifact_id}` | 404 |
| 18 | PATCH | `/v1/artifacts/{artifact_id}` | 404 |
| 19 | GET | `/v1/artifacts/{artifact_id}/versions/{version_id}` | 404 |
| 20 | GET | `/v1/artifacts/{artifact_id}/drafts` | 404 |
| 21 | POST | `/v1/artifacts/{artifact_id}/drafts` | 404 |
| 22 | PUT | `/v1/artifacts/{artifact_id}/drafts/{draft_id}` | 404 |
| 23 | POST | `/v1/artifacts/{artifact_id}/drafts/{draft_id}/seal` | 404 |
| 24 | POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/publish` | 404 |
| 25 | POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/withdraw` | 404 |
| 26 | PUT | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` | 404 |
| 27 | GET | `/v1/organizations/{org}/projects/{project}/library` | 404 |
| 28 | DELETE | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` | 404 |
| 29 | POST | `/v1/organizations/{org}/projects/{project}/resources` | 405 (GET, B6) |
| 30 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}` | 404 |
| 31 | POST | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` | 405 (GET, B7) |
| 32 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| 33 | PATCH | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| 34 | DELETE | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| 35 | POST | `/v1/admin/organizations/{organization_id}/sponsor` | 404 |
| 36 | GET | `/v1/sponsor-proposals/{proposal_id}` | 404 |
| 37 (B8) | GET | `/v1/users/me/sponsor-proposals` | 404 |
| 38 (B9) | GET | `/v1/organizations/{org}/sponsor-proposals` | 404 |
| 39 (B10) | POST | `/v1/sponsor-proposals/{proposal_id}/accept` | 404 |
| 40 (B11) | POST | `/v1/sponsor-proposals/{proposal_id}/decline` | 404 |
| 41 (B12) | POST | `/v1/sponsor-proposals/{proposal_id}/cancel` | 404 |

The status column was checked against the route decorators of the base:
- `routes/library.py:39-300`: no other method on rows 17-28.
- `routes/organizations.py`: no `/{org}/{segment}` catch-all.
- `routes/users.py`: no path parameter under `/v1/users/me`.

None of these paths starts with a BIM prefix of `main.py:187-199`, so their unrouted answers are not
`application/problem+json`. The API-key permission check is a route dependency (`access/dependencies.py:229`), so an
unrouted path never reaches it, and a key gets the same 404 as a session.

### 2.2 Kept (must stay and stay tested)

| # | Method | Path template | Why |
|---|---|---|---|
| B1 | GET | `/v1/organizations/{org}/projects/{project}/reports` | project data, publications screen |
| B2 | GET | `/v1/organizations/{org}/library` | study builder, version picker |
| B3 | GET | `/v1/artifacts/{artifact_id}/versions` | study detail, version picker |
| B4 | GET | `/v1/artifacts/{artifact_id}/versions/{version_id}/content` | study builder |
| B5 | POST | `/v1/artifacts/resolve` | case revision |
| B6 | GET | `/v1/organizations/{org}/projects/{project}/resources` | resources screen |
| B7 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` | resources screen |
| K1 | GET | `/v1/jobs/{job_id}/analysis/neighborhood` | run page (`req~studies-analysis-neighbourhood~1`) |
| K2 | GET | `/v1/organizations/{org}/projects/{project}/publications` | publications screen |
| K3 | DELETE | `/v1/organizations/{org}/projects/{project}/publications/{publication}` | withdraw a publication |
| K4 | GET | `/v1/explore/publications` | Explore |
| K5 | GET | `/v1/resolve/{kind}/{digest_value}` | permanent links (and its `/content` sibling) |

`PATCH /v1/organizations/{org}` stays with a narrower sponsor rule (§4). Package import and export (`/package`) stay
unchanged.

### 2.3 Frontend bindings that go

From m24-sunset design §2.3, plus the B8 to B12 bindings:

| Defining module | Binding | Rows |
|---|---|---|
| `analysis/archive.ts` | `analysisApi` (the whole module) | 1-8 |
| `api/platform.ts` | `platformApi.report`, `.createReport`, `.freezeReport`, `.createReportDraft`, `.updateReport`, `.deleteReport`, `.publishReport` | 9-15 |
| `api/platform.ts` | `platformApi.createResource`, `.createResourceRevision`, `.resource`, `.updateResource`, `.deleteResource` | 29, 31-34 |
| `api/libraryItems.ts` | `libraryItemsApi.create`, `.item`, `.rename`, `.drafts`, `.createDraft`, `.saveDraft`, `.seal`, `.publish`, `.withdraw`, `.associate`, `.projectItems`, `.dissociate` | 16-18, 20-28 |
| `api/library.ts` | `libraryApi.drafts` | 20 |
| `api/client.ts` | `adminTransferSponsor` | 35 |
| `api/client.ts` | `listMySponsorProposals`, `listOrganizationSponsorProposals`, `acceptSponsorProposal`, `declineSponsorProposal`, `cancelSponsorProposal` (and the private `answerSponsorProposal`) | 37-41 |
| `api/auth.ts` | types `SponsorProposal`, `SponsorProposalStatus`, `isSponsorProposal`; `api/client.ts` type `AdminSponsorTransferResult` | 35-41 |

Kept members of the same objects serve kept operations:
- `platformApi.reports`, `.resources`, `.resourceRevisions`;
- `libraryApi.list`, `.versions`, `.content`.

The module `api/libraryItems.ts` went as a whole: the screens read the library through `libraryApi`, so its read
members `libraryItemsApi.list`, `.versions`, `.content` and `.resolve` are gone too (the binding scan still does not
report those names).

## 3. Decisions

- **D1 Remove, do not stub.** Each removed operation loses its route, so FastAPI's router gives the generic 404 or
  405. A route that answers 410 was considered. It would keep a table of retired paths alive in code, which is the
  very kind of code this change deletes, and the owner asked for removal. 404/405 is what any unknown operation already
  gets.
- **D2 Delete `openspec/changes/m24-sunset/`.** Its 14 requirements specify `core/deprecation.py`, the 36-row table,
  the `Sunset` constant, the R1 release procedure and the removal gate. This change deletes the code, and the owner
  overrode the gate. The change was never archived (no `req~gateway-api-retired-operation` id under `openspec/specs`),
  so it cannot be modified from here, and archiving it would add 14 living requirements only to remove them again.
  Considered: keep it and REMOVE its ids at its archive. That leaves an unarchived change that contradicts the code
  for an unbounded time. The `[impl->]`/`[utest->]` tags to its ids live in `core/deprecation.py`,
  `test_retired_operations_deprecation.py` and `test_deprecation_unit.py`. Slice S2 deletes all three. The CI trace
  (`.github/workflows/ci.yml:285-292`) reads `openspec/specs`, not `openspec/changes`, so the deletion adds no trace
  defect before S2 lands.
- **D3 Remove the whole deprecation mechanism**: the middleware, the OpenAPI annotation, `Deprecation` and `Sunset` in
  `CORS_EXPOSED_HEADERS`, and the comment that names them (`core/settings.py:40-56`). `routes/pricing.py:61`
  (`deprecated=True` on `getPricingDocument`) is not part of it and stays. `m43-plans-pricing-route`
  (`design.md:227,276`, unarchived) planned `Deprecation` and `Link` on `/v1/pricing*` and to reuse
  `core/deprecation.py` (m24-sunset design §7). It must now bring its own mechanism, and its own exposure in
  `CORS_EXPOSED_HEADERS` if browsers need to read the header. When it does, it modifies
  `req~gateway-api-cors-exposed-headers~1` of this change. The no-header requirement of this change already exempts
  the three pricing paths.
- **D4 `docs/API_DEPRECATIONS.md` becomes the record of removals.** It lists the 41 operations as removed, with the
  removal date and the reason (ADR-0020). It drops the Deprecation/Sunset text. API clients that followed the page
  find what happened. Deleting the page was considered, but it would leave a dangling link in earlier release notes.
- **D5 Neighbourhood code stays.** `GET /v1/jobs/{job_id}/analysis/neighborhood` (`routes/v1.py:1211-1263`) uses
  `NeighborhoodResponse` (`models/analysis.py:7-45`) and the BIM service, and nothing in `v1/archive*.py` or
  `analysis_jobs.py`. The neighbourhood models move or stay; the archive and workspace models go. The API-key scope
  alias `"analysis": {"job", "jobs", "analysis"}` (`security/apikeys.py:267`) stays. The kept path contains the fixed
  segment `analysis`, and the alias makes a job-scoped key match it. Only the `/v1/analysis` branch of
  `required_permissions` (`:468-473`) and `analysis_work_permissions` (`:491-504`, also used at `main.py:1030`) go.
- **D6 API-key permission names stay.** Existing keys may hold `reports:write` or `engines:execute`. Both still
  guard kept operations, so no key row is migrated.
- **D7 The export tool reads by table name, not through ORM models.** It runs from the new image, whose ORM no longer
  maps `AnalysisTask` or `SponsorProposal`, against a database still at `b6c7d8e9f0a1`. It uses SQLAlchemy Core
  reflection of the six source tables, in one read-only transaction, so the six files are one consistent snapshot. The
  six selections are raw SQL text, duplicated as frozen copies in `tools/export_retired_data.py` and in the migration
  `alembic/versions/e7f8a9b0c1d2_drop_retired_data.py`, with the same primary-key columns, format and head. A migration
  must not import application code that keeps changing: a later edit of a shared module would silently change what an
  old revision deletes. `tests/test_drop_retired_data_migration.py` compares the two copies, and a second test exports,
  upgrades and compares the exported keys with the removed ones (§6.1).
- **D8 Narrower report delete than the brief's wording.** The brief says to delete "reports with state 'draft' that
  have NO publication". In the code a report returns to `draft` with its sealed `version_id` kept
  (`reports.py:40-53`, `new_report_draft`), and `GET /v1/resolve/report/{digest}` finds a version only through a
  `reports` row (`routes/resolve.py:420-435`). So deleting a draft report that has a sealed version would turn a
  working permanent link of a sealed version into 404. It would also drop the project-deletion protection that
  `version_id` gives (`routes/organizations.py:311`). The resolve query joins on `Report.artifact_id`
  (`routes/resolve.py:423`), and a report can stay in `draft` with an empty `version_id` while its artifact has a
  sealed version. That happens when a second draft of the artifact was sealed through `POST
  /v1/artifacts/{artifact_id}/drafts/{draft_id}/seal`: `adopt_sealed_report_draft` (`reports.py:117-120`) adopts only
  the report whose `draft_id` is the sealed draft. So this change deletes only draft reports that have
  `version_id IS NULL`, no publication, and an artifact without any `artifact_versions` row. Every other draft report
  is kept, together with its unsealed draft. This is stricter, never looser, than the approved drop. It is listed in
  the result for the coordinator to confirm.
- **D9 Sponsorship: refuse, do not propose.** `PATCH` naming another person answers 422 `sponsor_must_be_caller`. The
  check runs before that person is looked up, so the answer does not reveal whether the account exists or is active.
  The request field `replace_pending_proposal` is removed from `OrganizationUpdate` (`extra="forbid"`), so a client
  that still sends it gets 422 `validation_error`, not a silent no-op. The code `sponsor_must_be_caller` joins
  `docs/ERRORS.md`.
- **D10 Slices count added and changed lines.** Whole-file deletions are listed per slice and reviewed as deletions.
  They do not count against the ~300-line bound, which would otherwise split one deleted module across several PRs.

## 4. Sponsorship after the change

`PATCH /v1/organizations/{org}` with `billing_sponsor_user_id`:

| Caller | Named | Answer |
|---|---|---|
| not OWNER (ADMIN) | anyone different from the current sponsor | 403, as today (`require_role` OWNER, `organizations.py:284`) |
| OWNER | the current sponsor | 200, no sponsor change (as today: no-op) |
| OWNER | the caller | 200, the caller becomes sponsor of the organization and its subtree. Plan capacity is checked first (402 `sponsor_quota_exceeded`). The audit event `organization.updated` carries `previous_sponsor_user_id` and `new_sponsor_user_id` |
| OWNER | anyone else, existing or not, active or not | 422 `sponsor_must_be_caller`; nothing in the request is applied |

The transfer is one transaction (`transfer_sponsorship`, today in `sponsor_proposals.py:403`). It moves to a module
that survives, for example `services/sponsorship.py`, or into `routes/organizations.py`. `supersede_pending` goes with
the table. Account deactivation (`routes/admin.py:292-296`) and account deletion (`routes/users.py:786-787`) stop
calling `cancel_for_user`. The reconciler stops calling `sweep_expired` (`jobs/reconciler.py:348-350,382-383`). The
setting `sponsor_proposal_ttl_days` (`core/settings.py:364`) goes. Past notifications of kinds
`organization.sponsor.*` and audit events of target type `SponsorProposal` stay: they are history, and they reference
the proposal only by id inside JSON.

## 5. The analysis queue

These go:
- `analysis_jobs.py` and the `analyze_archive_message` actor (`worker.py:4,8`);
- `redeliver_analysis` in the reconciler (`reconciler.py:371-375`);
- `routes/analysis.py`, `v1/archive.py`, `v1/archive_geometry.py`, and the archive and workspace models of
  `models/analysis.py`;
- `tools/verify_analysis.py`, `tools/seed_analysis.py`, and the analysis hint of `tools/seed_dev.py`.

In the deployment files:
- `docker-compose.yml:270` (`analysis-worker`) and `:330` (`analysis-worker-dev`) go;
- `deploy/compose/production/compose.yaml:237` (`analysis-worker`) goes;
- the lab profiles keep one worker but change `--queues default analysis` to `--queues default` (`compose.lab.json:252`,
  `compose.lab-process.json:255`, `compose.lab-process-n1-probe.json:256`, `compose.lab-process-n2.json:255`,
  `compose.lab-process-n2-probe.json:256`).

The lab memory budget does not change, because no lab service is removed. Messages still waiting in Redis on the
`analysis` queue are not consumed by any worker after the change. Redis keeps them until its own eviction, and no
data depends on them, because the task rows are exported and dropped.

## 6. Data

### 6.1 Selections

The tool and the migration evaluate the same six selections at the same schema (`b6c7d8e9f0a1`). Each depends on the
ones above it:

| Source (file) | Rows |
|---|---|
| `analysis_tasks` | every row of `analysis_tasks` |
| `sponsor_proposals` | every row of `sponsor_proposals` |
| `report_drafts` | `reports` with `state = 'draft'`, `version_id IS NULL`, whose artifact has no `artifact_versions` row, and no `publications` row whose `report_id` is theirs |
| `report_artifact_drafts` | `artifact_drafts` with `sealed_version_id IS NULL`, whose artifact has `kind = 'Report'`, and that no `reports` row outside `report_drafts` references through `draft_id` (full rows, `payload` included) |
| `report_artifacts` | `artifacts` with `kind = 'Report'` that have no `artifact_versions` row, no `reports` row outside `report_drafts`, and no `artifact_drafts` row outside `report_artifact_drafts` |
| `report_project_artifacts` | `project_artifacts` whose `artifact_id` is in `report_artifacts` |

The upgrade deletes in foreign-key order: `report_drafts`, `report_artifact_drafts`, `report_project_artifacts`,
`report_artifacts`. Then it drops `analysis_tasks` and `sponsor_proposals`.

The only foreign keys into the deleted rows were checked at the base:
- into `artifacts`: `artifact_versions`, `artifact_drafts` (CASCADE), `project_artifacts`, `reports.artifact_id`;
- into `artifact_drafts`: `reports.draft_id`;
- into `reports`: `publications.report_id`.

None of them can point from a kept row to a deleted one, by the definitions above. If one ever did, `RESTRICT` would
fail the transaction and nothing would change. Kept: everything else, in particular:
- `publications` and `artifact_publications`;
- `artifact_versions`, `artifact_dependencies`, `artifact_evidence`, `case_artifacts`, `binding_case_revisions`;
- `studies`, `study_runs`, `study_cells`;
- `project_resources` and their revisions;
- every other `project_artifacts` row;
- unsealed drafts of other kinds, frozen reports, and draft reports that have a version, whose artifact has a
  version, or that have a publication;
- `organizations.billing_sponsor_user_id`;
- notifications and audit events.

The immutability triggers of `db/artifact_models.py:117-179` are untouched: no deleted table carries one, and
`artifacts` has only an `UPDATE` trigger.

### 6.2 Export format

`python tools/export_retired_data.py --out DIR` (from `openbinding-gateway/`, `DATABASE_URL` as for the other tools):

- `DIR` is created if missing. If it exists and holds any entry, the tool exits with status 2 and writes nothing.
- If the database's `alembic_version` is not `b6c7d8e9f0a1`, the tool exits with status 2 and writes nothing.
- It writes one file per source, `<source>.jsonl`. Each file is UTF-8 with one JSON object per line and `\n` after
  every line, and has as many lines as the source has rows. The keys of each object are the table's column names,
  with these values:
  - UUIDs as lowercase hyphenated strings;
  - timestamps as ISO 8601 in UTC with a `Z` suffix;
  - JSON columns as JSON values;
  - enum columns as their stored string.

  Lines are ordered by primary key; `project_artifacts` by `(project_id, artifact_id)`. An empty source gives an empty
  file.
- Then it writes `manifest.json`:

```json
{
  "format": "openbinding-m96-export/1",
  "alembic_head": "b6c7d8e9f0a1",
  "exported_at": "2026-10-28T09:15:00Z",
  "sources": {
    "analysis_tasks": {"file": "analysis_tasks.jsonl", "rows": 3, "sha256": "<64 lowercase hex>"},
    "sponsor_proposals": {"file": "sponsor_proposals.jsonl", "rows": 1, "sha256": "..."},
    "report_drafts": {"file": "report_drafts.jsonl", "rows": 2, "sha256": "..."},
    "report_artifact_drafts": {"file": "report_artifact_drafts.jsonl", "rows": 2, "sha256": "..."},
    "report_artifacts": {"file": "report_artifacts.jsonl", "rows": 2, "sha256": "..."},
    "report_project_artifacts": {"file": "report_project_artifacts.jsonl", "rows": 2, "sha256": "..."}
  }
}
```

- On success it exits 0 and prints the absolute path of `manifest.json`.

### 6.3 Guard

Before any change, the new revision counts the six selections. If all counts are zero, it proceeds and needs no
manifest. Otherwise it reads the path in `OPENBINDING_M96_EXPORT_MANIFEST` and proceeds only if all of these hold:
- the file exists and parses as the format of §6.2;
- `alembic_head` is `b6c7d8e9f0a1`;
- every one of the six sources is present, with `rows` equal to the current count;
- the SHA-256 of each named file, resolved against the manifest's directory, equals `sha256`;
- the set of primary keys read from each file equals the set of primary keys the selection returns now.

Otherwise it raises before any statement that changes data. The message names:
- the first failing check, and the source when there is one;
- the variable `OPENBINDING_M96_EXPORT_MANIFEST`;
- the command `python tools/export_retired_data.py --out DIR`.

`alembic upgrade head` then exits non-zero. Because the primary-key sets are compared, a database where other rows
fall in a selection than at export time is refused even with equal counts. What remains: a selected row whose other
columns were edited after the export (same key) passes, and its export holds the earlier values. The runbook (§6.4)
runs the export with the gateway stopped, right before the upgrade, so nothing edits them in between.

### 6.4 Runbook (lab, preview, any database with rows)

The container entrypoint applies `alembic upgrade head` at start (`req~lab-deployment-migrate-on-start~1`), so:

1. Stop the gateway and workers of the old release.
2. Run the export from the new image without its entrypoint, against the same database, into a mounted directory, for
   example: `docker compose run --rm --no-deps --entrypoint python -v ./m96-export:/export gateway
   tools/export_retired_data.py --out /export/m96`.
3. Keep the directory (it is the only copy of the dropped rows). Start the new release with
   `OPENBINDING_M96_EXPORT_MANIFEST=/export/m96/manifest.json` and the same mount on the gateway service.

A fresh database (CI, a new preview) has no rows and needs none of this. The variable may stay set afterwards: the
revision runs once.

### 6.5 Downgrade

The downgrade recreates `analysis_tasks` and `sponsor_proposals` empty, with the columns, constraints and indexes they
had at `b6c7d8e9f0a1`, including the partial unique index `uq_sponsor_proposal_pending`. It does not restore deleted
rows. Restoring from the export is a manual step outside this change.

## 7. Consequences stated plainly

- After this change, no kept operation creates a report publication or makes an artifact version public:
  - `POST .../publications` (row 15) and `POST .../versions/{version_id}/publish` (row 24) were the only creators of a
    new `publications` row and the only creator of an `artifact_publications` row (`routes/library.py:243`).
  - Package import still adds a `publications` row in the importing project, but only for a report version that
    already has an `artifact_publications` row (`routes/artifacts.py:1230-1255`; 409 `unpublished_import` otherwise).
  - Existing publications keep answering at `GET /v1/resolve/{kind}/{digest_value}` (for example
    `/v1/resolve/report/{digest}`), in the project publication list (K2) and in Explore (K4).
  - The new creator of published results is M6.5 (ADR-0020 decision 3).
- `/p/{id}` and `/c/{id}` do not exist. ROADMAP M3.5 (`ROADMAP.md:109`) plans them, so the requirements name
  `/v1/resolve/{kind}/{digest_value}`.
- A new sealed Dataset (or any other kind) version can no longer be created through `POST /v1/organizations/{org}/library`
  and the draft and seal routes. Package import and the study, collection and case creators seal versions through the
  internal artifact service (`artifacts.seal_draft`, `materialize_case`). They are unchanged.
- Living-spec prose that names the removed parts is left as it is, because a delta can change only requirements:
  - studies-analysis Purpose and TODO;
  - auth-roles-entitlements TODO line 144;
  - collaboration-artifacts Purpose lines 8 and 11, TODO line 118;
  - job-execution Out of scope.

  The archive task edits that prose (tasks.md, Archive).
- `job-execution` `req~job-execution-lease-recovery~1` ("Recovery of lost workers") names no analysis task, so it
  needs no change. The analysis attempts rule lived in `req~studies-analysis-task-permissions-attempts~1`, removed
  here.
- `lab-deployment`: no living requirement names the analysis worker. The new requirement pins its absence.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Rows dropped without a copy | Guard of §6.3 (counts, hashes and primary-key sets); tests of every refusal, one per source; runbook §6.4 |
| Export and drop disagree on rows | The same SQL in the tool and the migration, compared by a test (D7); a test exports, upgrades, and compares the exported ids with the removed ids |
| A permanent link of a sealed version breaks | D8; a test resolves every sealed report and case version before and after the upgrade |
| A sealed problem version compiles differently | No code that compiles a case is touched. A test compiles every sealed case revision before and after the upgrade and compares IR digests |
| A kept screen calls a removed operation | Frontend binding scan; TypeScript build with the bindings deleted; the kept members are listed in §2.3 |
| Tests that used removed routes as setup lose coverage | They seed through the internal services instead. The tests cited as Evidence in living specs keep their names (tasks.md) |
| A deployment with rows does not start after the upgrade | Intended (owner's guard). Runbook §6.4; the error names the tool and variable |
| Analysis messages left in Redis | Harmless (§5) |
| m43 loses the shared deprecation module | D3; m43 is unmerged in code |

## 9. Requirement ids

| Capability | Operation | Ids |
|---|---|---|
| gateway-api | ADDED | `req~gateway-api-removed-operations-not-routed~1`, `req~gateway-api-removed-operations-not-documented~1`, `req~gateway-api-kept-retired-area-operations~1`, `req~gateway-api-no-retirement-headers~1`, `req~gateway-api-cors-exposed-headers~1`, `req~gateway-api-removed-operations-page~1` |
| data-retirement | ADDED | `req~data-retirement-export-files~1`, `req~data-retirement-export-selection~1`, `req~data-retirement-export-manifest~1`, `req~data-retirement-export-refusals~1`, `req~data-retirement-guard~1`, `req~data-retirement-guard-empty~1`, `req~data-retirement-removed-set~1`, `req~data-retirement-kept-set~1`, `req~data-retirement-sealed-ir-unchanged~1`, `req~data-retirement-publications-answer~1`, `req~data-retirement-downgrade~1` |
| auth-roles-entitlements | ADDED | `req~auth-roles-entitlements-sponsor-caller-only~1`, `req~auth-roles-entitlements-sponsor-self-transfer~1`, `req~auth-roles-entitlements-account-lifecycle-without-proposals~1` |
| collaboration-artifacts | ADDED | `req~collaboration-artifacts-resources-read-only~1`, `req~collaboration-artifacts-library-read-only~1`, `req~collaboration-artifacts-import-publication-requires-published~1` |
| studies-analysis | REMOVED | `req~studies-analysis-task-permissions-attempts~1` ("Analysis work permissions and attempts") |
| job-execution | ADDED | `req~job-execution-default-queue-only~1`, `req~job-execution-reconciler-without-retired-sweeps~1` |
| lab-deployment | ADDED | `req~lab-deployment-no-analysis-worker~1` |
| frontend-workspace | ADDED | `req~frontend-workspace-no-removed-operation-binding~1`, `req~frontend-workspace-org-sponsor-self-only~1`, `req~frontend-workspace-no-sponsor-requests~1` |

Deleted with `m24-sunset` (never archived), 14 requirements:
- `req~gateway-api-retired-operation-set~1`, `-deprecation~1`, `-no-match~1`, `-sunset~1`, `-no-sunset~1`,
  `-sunset-by-release~1`, `-sunset-floor~1`, `-openapi~1`, `-openapi-headers~1`, `-unchanged~1`, `-no-kept-caller~1`,
  `-removal-gate~1`, `-docs~1`;
- `req~gateway-api-deprecation-headers-exposed~1`.

## 10. Open questions (owner or coordinator)

- Q1 [NEEDS CLARIFICATION: Should package import (`/package`) keep importing draft reports (it creates a `Report` artifact, an unsealed draft and a `draft` report, `routes/artifacts.py:1222-1226`) after M9.6, or refuse them with 422 now that no route can edit a draft report?] This change keeps package import unchanged, as the brief says. Draft reports created by a later import are not removed by this revision, which runs once.
- Q2 [NEEDS CLARIFICATION: Should the caller-only sponsor rule also cover `POST /v1/organizations`, where a platform administrator may name another person as sponsor (`routes/organizations.py:203`), and account deletion, which makes the next OWNER the sponsor without asking (`routes/users.py:641-648`)?] This change leaves both as they are.

## 11. Known follow-ups (not in this change)

- (a) ADR-0020 decision 5 (`docs/adr/0020-smaller-platform.md:45-47`) still requires a minor release with
  `Deprecation` and `Sunset` headers before endpoints go, and `ROADMAP.md` still describes that release in the M2.4 row
  (`:69`, `:78-79`) and in the M9.6 row ("after the Sunset of M2.4", `:190`). The owner skipped that period (§1). An
  owner-area follow-up in `docs/adr/` must amend ADR-0020 decision 5, or mark it deprecated by a new ADR, before the
  release pull request; the ROADMAP rows are corrected with it.
- (b) `publish_version` and `withdraw_version` (`routes/library.py`) and `publish_report` (`routes/studies.py`) are no
  longer routed but stay in route modules, because `tools/seed_dev.py` publishes its demonstration report through them
  (and `withdraw_version` serves the kept `DELETE .../publications/{publication}`). They move to a `services/` module.
- (c) `reports.new_report_draft` has no caller in `src` any more (only `tools/seed_dev.py` and the test seed helpers
  use it), and the tables `project_resources` and `project_resource_revisions` are frozen: no route writes them, B6
  and B7 read resources from the artifact store, and only the package export (`routes/artifacts.py:408`), the admin
  data listing and the deletion paths still read them. Their fate is decided together with Q1 (package import still
  creates draft reports).
- (d) An organization whose only OWNER is also its sponsor and is deactivated has no recovery path: the administrator
  sponsor transfer (row 35) is gone and nobody else can make themselves the sponsor. This joins Q2.
