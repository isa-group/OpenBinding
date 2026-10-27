# Tasks: m96-remove-retired

M9.6, after the owner decision of 2026-10-27 (design.md §1). The slices below each have one capability and disjoint
files. Each one merges into `develop` as its own PR, in the order given, and never leaves a kept screen calling a
removed route, the code using a dropped table, or a test pinning a route that is gone.
- Tests carry `[utest->req~…~1]` and code carries `[impl->req~…~1]` for the ids of design.md §9.
- Each slice's tests are written first and run red on the slice's base, except negative controls, which are named.
- The bound is ~300 added or changed lines. Whole-file deletions are listed and reviewed as deletions (design.md D10).
- Tests cited as `Evidence` by the living specs keep their names, and only their setup moves off removed routes:
  - `test_artifact_library.py::test_sealed_versions_are_private_exact_and_sql_immutable` and
    `::test_case_composition_closes_exact_resources_without_copying_authority`;
  - `test_collaboration_platform.py::test_sealed_reports_protect_project_and_organization_history`;
  - `test_b3_public_read.py::test_reports_are_only_the_frozen_ones_with_a_live_publication` and
    `::test_the_library_shows_only_published_artifacts_to_visitors`.

  The new setup seeds through the internal services (`artifacts.seal_draft`, `reports.create_report_context`,
  `reports.seal_report`) or through package import.

Checks to register. The argv is listed; `cwd` is the repository root unless noted.
1. G1: `["openspec","validate","m96-remove-retired","--strict"]`. CI also runs `openspec validate --strict --all`,
   report-only.
2. G9: `["git","diff","--check"]`.
3. G5 `gateway-unit` (`openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest"]`.
4. Slice red/green (`openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest","-q","-p","no:cacheprovider","<the slice's new test files>"]`.
5. G5 PostgreSQL (`openbinding-gateway`, with the `compose.pgtest.json` harness): `["uv","run","--locked","--extra","test","pytest","tests/concurrency/test_m96_migration_pg.py"]`.
6. G7 `openapi-snapshot` (`openbinding-gateway`): `["uv","run","--locked","python","tools/dump_openapi.py","--check"]`.
7. G7 contracts (`openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest","tests/test_openapi_contract.py","tests/test_b4_problem_schema.py","tests/test_bim_consumer_contract.py","tests/test_api_key_route_table.py"]`.
8. G9 ruff (`openbinding-gateway`): `["uv","run","--locked","--extra","test","ruff","check","src","tests","tools","alembic"]`.
9. G9 import contracts (`openbinding-gateway`): `["uv","run","--locked","--extra","test","--group","lint","lint-imports","--config",".importlinter"]`, and the same with `importlinter-modules.ini`.
10. Frontend (`frontend`): `["pnpm","install","--frozen-lockfile"]`, then `["pnpm","test"]`, `["pnpm","lint"]` and `["pnpm","build"]`.
11. Lab static checks: `["uv","run","--project","openbinding-gateway","--locked","--extra","test","pytest","lab/tests/test_lab_compose.py"]`.
12. G9 `changelog`: `["python3","tools/generate_changelog.py","--check"]`.

## S0. Specification (specifier)

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md` and the eight delta specs. 29 ADDED requirements and 1 REMOVED
  (design.md §9).
- [x] 0.2 Delete `openspec/changes/m24-sunset/` (design.md D2).
- [ ] 0.3 G1 (check 1) green, then the G2 EPIC review by the spec-auditor. The owner or coordinator answers design.md
  §10 Q1 and Q2, and confirms D8.

## S1. Export tool (data-retirement), first

Owned:
- `openbinding-gateway/src/openbinding_gateway/retired_data.py` (new: the six selections of design.md §6.1 as
  SQLAlchemy Core queries over reflected tables, and the manifest reader and writer);
- `openbinding-gateway/tools/export_retired_data.py` (new);
- `openbinding-gateway/tests/test_export_retired_data.py` (new).

No other file changes. The tool is usable on its own while every route still exists.

- [x] 1.1 Tests first: `-export-files`, `-export-selection` (every scenario except "Export equals removal", which is
  S8), `-export-manifest` and `-export-refusals`. They build the schema with `alembic upgrade b6c7d8e9f0a1`, seed with
  SQLAlchemy Core inserts by table name and run on SQLite. They never import the ORM classes that S5 and S6 delete
  (`AnalysisTask`, `SponsorProposal`), so they stay green after those slices. They are red on the base (no tool).
- [x] 1.2 The selection module, then the tool (design.md §6.2, D7): reflection, one read-only transaction, the
  ordering, value encoding and exit codes.
- [ ] 1.3 Checks 4, 3, 8, 9, 2.

## S2. Deprecation mechanism (gateway-api), before any route goes

It comes first among the gateway slices because the m24 tests pin every class-A row as a live route, and they would
fail as soon as one route goes.

Owned:
- deleted: `openbinding-gateway/src/openbinding_gateway/core/deprecation.py`;
- edited: `main.py` (the middleware registration and the `annotate_retired_operations` call), `core/settings.py`
  (`CORS_EXPOSED_HEADERS` and its comment, design.md D3);
- tests, deleted: `tests/test_retired_operations_deprecation.py`, `tests/test_deprecation_unit.py`;
- tests, edited: `tests/test_b2_cors.py`; `tests/test_removed_operations.py` (new, the header part);
- docs: `docs/openapi.json` (regenerated); `docs/API_DEPRECATIONS.md` (only the header statements go; the full
  rewrite is S7).

- [x] 2.1 Tests first: `-no-retirement-headers` and `-cors-exposed-headers`. They are red on the base.
  (`tests/test_deprecation_removed.py`, with `tests/test_b2_cors.py`.)
- [x] 2.2 Remove the mechanism. `getPricingDocument` keeps `deprecated: true` (`routes/pricing.py:61`).
- [ ] 2.3 Checks 4, 3, 6, 7, 8, 9, 12, 2.

## S3. Sponsorship screens (frontend-workspace), before the gateway removes B8 to B12

Owned:
- `frontend/src/pages/Organization/OrgSettings.tsx`, `SponsorCards.tsx`, `sponsorModel.ts` (and their tests);
- `frontend/src/pages/Account/SponsorRequestsForYou.tsx` (deleted), `AccountNotifications.tsx`,
  `AccountNotifications.css` (and their tests);
- `frontend/src/components/NotificationDropdown/*`.

- [x] 3.1 Tests first: `-org-sponsor-self-only` and `-no-sponsor-requests`. They are red on the base.
- [x] 3.2 Organization settings:
  - the "New sponsor" choice offers only "Me (<username>)", or no control when the caller already sponsors;
  - the "Sponsor requests" section, the request card and the replace flow go;
  - the explanatory text says that only you can make yourself the sponsor.
- [x] 3.3 The notifications screen drops `SponsorRequestsForYou`. The dropdown stops fetching sponsor requests, and its
  badge and accessible name count only unread notifications.
- [ ] 3.4 Check 10 and the Playwright specs that cover these screens (baseline updates reviewed per
  factory:playwright-visual). Check 2.

## S4. Frontend client bindings (frontend-workspace)

Owned: `frontend/src/api/client.ts`, `api/auth.ts`, `api/platform.ts`, `api/libraryItems.ts`, `api/library.ts`,
`frontend/src/analysis/archive.ts` (deleted), the tests of those modules, `frontend/src/test/fixtures/analysis.ts`,
and `frontend/src/api/removedOperations.test.ts` (new). Depends on S3.

- [x] 4.1 Test first: `-no-removed-operation-binding`. It is red on the base, where the bindings exist.
- [x] 4.2 Delete the bindings and types of design.md §2.3. `platformApi.updateOrganization` loses
  `replace_pending_proposal` and its `SponsorProposal` result type. The doc comment in `client.ts` says that naming
  anyone but yourself is refused with `sponsor_must_be_caller`.
- [ ] 4.3 Check 10, then check 2.

## S5. Analysis queue, worker and workspace (job-execution, lab-deployment, and the studies-analysis removal)

Owned, gateway:
- deleted: `routes/analysis.py`, `analysis_jobs.py`, `v1/archive.py`, `v1/archive_geometry.py`;
- edited:
  - `models/analysis.py`: only the neighbourhood models stay;
  - `worker.py`;
  - `jobs/reconciler.py`: drop `redeliver_analysis`;
  - `security/apikeys.py`: drop the `/v1/analysis` branch and `analysis_work_permissions`, and keep the `analysis`
    alias (design.md D5);
  - `main.py`: the router and the `analysis_work_permissions` uses;
  - `db/models.py`: drop `AnalysisTask`;
  - `v1/__init__.py`;
  - `reports.py`: the `v1.archive.safe` import. Keep the behaviour of `report_evidence` for kept callers, or move
    `safe` next to it;
- tools: `tools/verify_analysis.py` and `tools/seed_analysis.py` (deleted), `tools/seed_dev.py`.

Tests:
- deleted: `test_archive_analysis.py`, `test_apikey_analysis_scopes.py`, `test_analysis_task_attempts.py`;
- edited: `test_job_reconciler.py`, `test_api_key_route_table.py`, `test_architecture_layers.py`,
  `test_v1_persistence.py`, and `test_compose_worker_secrets.py`. That last file's
  `test_analysis_workers_inherit_dramatiq_without_secret` asserts `analysis-worker` and `analysis-worker-dev` exist
  (`:42-46`). It keeps `worker` and `worker-dev` and gains the no-analysis-queue check of
  `req~lab-deployment-no-analysis-worker~1`;
- new: `test_worker_queues.py`.

Deployment files go in the same slice, because the worker and its services go together:
- `docker-compose.yml`, `deploy/compose/production/compose.yaml`, `compose.lab*.json`;
- `lab/tests/test_lab_compose.py`, and `lab/tests/test_ci_gate_tooling.py` if it names the analysis worker.

Depends on S2 and S4.

- [ ] 5.1 Tests first: `-default-queue-only`, `-reconciler-without-retired-sweeps` (the analysis part) and
  `-no-analysis-worker`. They are red on the base.
- [ ] 5.2 Remove the code and the services (design.md §5). The rows 1 to 8 of
  `req~gateway-api-removed-operations-not-routed~1` now answer 404. Their assertions join `test_removed_operations.py`
  in S7.
- [ ] 5.3 `test_binding_analysis.py` passes unedited (`req~studies-analysis-neighbourhood~1`).
- [ ] 5.4 Checks 4, 3, 6 (regenerate `docs/openapi.json`), 7, 8, 9, 11, 12, 2. Review panel: reviewer and
  arch-reviewer (worker and deployment).

## S6. Sponsorship proposals and the admin transfer (auth-roles-entitlements)

Owned, gateway:
- deleted: `routes/sponsor_proposals.py`, `sponsor_proposals.py`. The self-transfer moves to a surviving module
  (design.md §4);
- edited:
  - `routes/organizations.py`: `update_organization` and its OpenAPI responses;
  - `routes/admin.py`: the transfer route, and `cancel_for_user` on deactivation;
  - `routes/users.py`: `cancel_for_user` on deletion;
  - `jobs/reconciler.py`: `sweep_expired`;
  - `models/platform.py`: `OrganizationUpdate.replace_pending_proposal` and `SponsorProposalView`;
  - `db/platform_models.py`: `SponsorProposal`;
  - `db/models.py`: the re-export;
  - `core/settings.py`: `sponsor_proposal_ttl_days`;
  - `main.py`: the router;
- docs: `docs/ERRORS.md` (`sponsor_must_be_caller`).

Tests:
- deleted: `test_b3_sponsor_proposals.py`;
- edited: `test_admin_security_separation.py`, `test_b2_admin_audit.py`, `test_job_reconciler.py`;
- new: `test_org_sponsor_caller_only.py` and `test_sponsor_proposals_removed.py` (the removal of the proposal routes).
  S2 adds `test_deprecation_removed.py` and S7 completes `test_removed_operations.py`.

Depends on S3, S4 and S5.

- [x] 6.1 Tests first: `-sponsor-caller-only`, `-sponsor-self-transfer`, `-account-lifecycle-without-proposals`, and
  the proposal part of `-reconciler-without-retired-sweeps`. They are red on the base, except "Naming the current
  sponsor", "Plan too small" and "ADMIN names themselves", which are negative controls.
- [x] 6.2 Implement design.md §4 and D9.
- [ ] 6.3 Checks 4, 3, 6, 7, 8, 9, 12, 2. Review panel: reviewer and security-auditor (an authorization rule changes).

## S7. Library, report editor and project resources (gateway-api and collaboration-artifacts)

Owned, gateway:
- `routes/library.py`: keep B2 to B5 only;
- `routes/studies.py`: rows 9 to 15; keep K2 to K4;
- `routes/organizations.py`: rows 29 to 34; keep B6 and B7;
- the request and view models in `models/` that only removed routes use.

Docs: `docs/openapi.json` (regenerated) and `docs/API_DEPRECATIONS.md` (rewritten, design.md D4).

Tests:
- `test_removed_operations.py` gets the complete removal table;
- these change in their setup only (see the list at the top): `test_artifact_library.py`, `test_artifacts_platform.py`,
  `test_collaboration_platform.py`, `test_b3_public_read.py`, `test_b3_openapi.py`, `test_platform_crud_extensions.py`,
  `test_studies_platform.py`, `test_viewer_read_only.py`, `test_library_content_headers.py`, `test_citations.py`,
  `test_b2_resolve_urls.py`, `test_v1_lifecycle_rbac.py`, `test_b1_cell_result.py`, `test_error_event_purge.py`,
  `test_openapi_contract.py`, `test_api_key_route_table.py`.

The test setup takes this slice past ~300 changed lines, so it is split:
- S7a: the library and project library, rows 16 to 28;
- S7b: the report editor and the resources, rows 9 to 15 and 29 to 34, plus the page.

Depends on S4, S5 and S6.

- [ ] 7.1 Tests first:
  - `-removed-operations-not-routed`, `-removed-operations-not-documented`, `-kept-retired-area-operations`,
    `-removed-operations-page`;
  - `collaboration-artifacts` `-resources-read-only` and `-library-read-only`;
  - `-import-publication-requires-published`, a negative control: it passes on the base and pins the only remaining
    publication creator.

  The rest are red on the base.
- [ ] 7.2 Remove the routes, regenerate `docs/openapi.json`, and rewrite `docs/API_DEPRECATIONS.md`.
- [ ] 7.3 Checks 4, 3, 6, 7, 8, 9, 12, 2. G13:
  - `curl -si "$PREVIEW/v1/analysis/sources"` shows 404 and no `Deprecation`;
  - `curl -si -X POST "$PREVIEW/v1/organizations/isa-demo/library"` shows 405 with `Allow: GET`;
  - `curl -si "$PREVIEW/v1/organizations/isa-demo/projects/p1/resources"` answers as before.

  Review panel: reviewer, test-reviewer and arch-reviewer.

## S8. The migration (data-retirement), last

Owned:
- `openbinding-gateway/alembic/versions/<rev>_m96_drop_retired_data.py` (new, `down_revision = "b6c7d8e9f0a1"`);
- `openbinding-gateway/tests/test_m96_migration.py` (new);
- `openbinding-gateway/tests/concurrency/test_m96_migration_pg.py` (new);
- `openbinding-gateway/tests/test_remote_cancel.py` and `test_b3_migration.py`, if they pin the head;
- `docs/qa/PROCESS_DEPLOYMENT.md` (the runbook of design.md §6.4).

Depends on S1 and S5 to S7: no code maps the dropped tables any more.

- [ ] 8.1 Tests first:
  - `-guard`, `-guard-empty`, `-removed-set`, `-kept-set`, `-downgrade`;
  - "Export equals removal" of `-export-selection`;
  - `-sealed-ir-unchanged` and `-publications-answer`.

  Each test seeds a database at `b6c7d8e9f0a1` with the base schema (`alembic upgrade b6c7d8e9f0a1`) and runs the S1
  tool. They are red on the base (no revision).
- [ ] 8.2 The revision:
  - the guard (design.md §6.3), reusing `retired_data.py`;
  - the deletes in the order of §6.1, then the drops;
  - one transaction;
  - the downgrade (§6.5).
- [ ] 8.3 Write the runbook, and run it on the lab database before the preview: export, keep the directory, set
  `OPENBINDING_M96_EXPORT_MANIFEST`.
- [ ] 8.4 Checks 4, 5, 3, 8, 9, 12, 2. Review panel: reviewer, test-reviewer and security-auditor (irreversible data
  change). The MRP shows the export manifest of the lab database.

## S9. Roadmap status (doc-steward), after S8 merges

- [ ] 9.1 `ROADMAP.md`: the M9.6 row status records the removal and the export (never the `Status: PROPOSED` lines).
  Checks 2 and 12.

## Archive (later, explicit archive task)

- [ ] Archive into `openspec/specs`. In the same task, edit the living-spec prose that still names the removed parts
  (design.md §7):
  - studies-analysis Purpose and TODO;
  - auth-roles-entitlements TODO "Sponsorship proposals";
  - collaboration-artifacts Purpose and TODO "sponsor transfer atomic";
  - job-execution Out of scope "analysis tasks".

  Then run `["openspec","archive","m96-remove-retired","--yes"]` and `["openspec","validate","--all","--strict"]`.
- [ ] At the m24 archive, reconcile `req~frontend-retire-gateway-untouched~1` (change `m24-retire-screens`). It refers
  to `Deprecation` headers that no longer exist.

## Follow-ups outside this change

- Q1 and Q2 of design.md §10: package import of draft reports, and the sponsor rule of organization creation and
  account deletion.
- `m43-plans-pricing-route`: bring its own `Deprecation` mechanism and CORS exposure if it still wants them, and
  modify `req~gateway-api-cors-exposed-headers~1` (design.md D3).
- M6.5: the new creator of published results (design.md §7).
