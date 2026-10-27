# Change: m96-remove-retired

## Why

ROADMAP M9.6 (`ROADMAP.md:190`): "Retired endpoints, code and data (ADR-0020, after the Sunset of M2.4): endpoints
removed (CRP); the `analysis` queue and worker removed; report drafts, decision-space workspaces and sponsorship
proposals exported and dropped (CRP)", accepted when "`docs/openapi.json` shrinks; every sealed problem version
compiles to the same IR; existing publications still answer at their permanent links". ADR-0020 decision 5: "Screens go
first, then endpoints ... Code goes next. Data goes last, by a CRP migration that keeps every sealed digest valid."
INTENT objective O12 (Surface; principle 12, journeys decide what exists).

Owner decision of 2026-10-27, request own-622ca38adc35425586b2be0f895e9b8d: "Sunset now... no hay nada en produccion".
It does two things:
- It overrides the M2.4 removal gate (`req~gateway-api-retired-operation-removal-gate~1` of change `m24-sunset`: a
  release carrying `Deprecation` and `Sunset`, then a passed Sunset date). The operations go now.
- It approves the irreversible data drop, with one guard: an export tool is written and tested first, and the migration
  refuses to drop or delete non-empty data until the export has run.

The coordinator approved removing, together with the 36 class-A operations, the 5 sponsorship-proposal operations B8
to B12, which were not among the 36.

## What Changes

- 41 gateway operations are removed: the 36 class-A rows of m24-sunset (decision-space workspace, report editor, library
  catalogue, project library, project resource writes and reads, admin sponsor transfer, one proposal read) and the 5
  proposal operations B8 to B12. They answer the generic 404, or 405 where the path stays for another method, and
  `docs/openapi.json` loses them. The kept readers (B1 to B7, the job neighbourhood, publication reads, `/v1/resolve`)
  do not change.
- The `Deprecation` middleware, its headers, their CORS exposure and their OpenAPI annotation are removed. Change
  `m24-sunset` is superseded, and its directory is deleted (see Impact).
- The `analysis` Dramatiq queue, its worker services, the analysis task code and the archive (workspace) code are
  removed. The `default` (solve) queue stays.
- Sponsorship: `PATCH /v1/organizations/{org}` may name only the caller as billing sponsor. Naming anyone else is
  refused with 422 `sponsor_must_be_caller`. Nobody can make another person pay. The organization settings screen
  offers only "Me", and the account and notification screens no longer show sponsor requests.
- Data: a new tool, `openbinding-gateway/tools/export_retired_data.py`, exports the retired rows to JSON Lines with a
  manifest. A new Alembic revision then drops `analysis_tasks` and `sponsor_proposals` and deletes report drafts and
  their never-versioned report artifacts. It refuses while non-empty data has no matching export. Publications, sealed
  versions, evidence, studies and project resources are kept.
- Honest consequence: after this change no kept operation makes a version public. Existing publications keep answering
  at `GET /v1/resolve/{kind}/{digest}`.

## Impact

- Capabilities (eight, justified below):
  - `gateway-api`: 6 ADDED.
  - `data-retirement` (new): 11 ADDED.
  - `auth-roles-entitlements`: 3 ADDED.
  - `collaboration-artifacts`: 3 ADDED.
  - `studies-analysis`: 1 REMOVED.
  - `job-execution`: 2 ADDED.
  - `lab-deployment`: 1 ADDED.
  - `frontend-workspace`: 3 ADDED.

  The list of ids is in design.md §9. M9.6 is one owner decision that removes one retired surface from every layer that
  carries it. Splitting it by capability would leave a gateway that serves routes whose tables are gone, or screens that
  call routes that are gone. tasks.md slices the work by capability, with disjoint files.
- Superseded change: `openspec/changes/m24-sunset/` is deleted in this change. Its 14 requirements
  (`req~gateway-api-retired-operation-*~1`, `req~gateway-api-deprecation-headers-exposed~1`) describe
  `core/deprecation.py`, the 36-row table and the R1 Sunset procedure. This change deletes all of them. They were never
  archived into `openspec/specs/`, so no living requirement is removed with them. Code and tests still carry
  `[impl->]`/`[utest->]` tags to those ids until slice S2 deletes the files that hold them. CI traces only
  `openspec/specs`, so no new trace defect appears (design.md D2).
- Other unarchived changes are left untouched. `m43-plans-pricing-route` planned to reuse `core/deprecation.py`. It must
  now bring its own mechanism if it still wants `Deprecation` on `/v1/pricing*` (design.md D3).
- Code areas (tasks.md lists the slices):
  - gateway routes: `analysis.py`, `library.py`, `studies.py` (report editor and `POST publications`),
    `organizations.py`, `admin.py`, `sponsor_proposals.py`, `users.py`;
  - `analysis_jobs.py`, `v1/archive*.py`, `models/analysis.py` (the neighbourhood models stay),
    `sponsor_proposals.py`, `core/deprecation.py`, `core/settings.py`, `security/apikeys.py`, `jobs/reconciler.py`,
    `worker.py`, `main.py`;
  - a new Alembic revision with down_revision `b6c7d8e9f0a1`, and `tools/export_retired_data.py` (new);
  - `tools/verify_analysis.py` and `tools/seed_analysis.py` (deleted), `tools/seed_dev.py`;
  - `docker-compose.yml`, `deploy/compose/production/compose.yaml`, `compose.lab*.json`;
  - frontend: `api/client.ts`, `api/auth.ts`, `api/platform.ts`, `api/libraryItems.ts`, `api/library.ts`,
    `analysis/archive.ts`, `pages/Organization/OrgSettings.tsx`, `SponsorCards.tsx`, `sponsorModel.ts`,
    `pages/Account/SponsorRequestsForYou.tsx`, `AccountNotifications.tsx`, `components/NotificationDropdown`;
  - `docs/openapi.json` (regenerated) and `docs/API_DEPRECATIONS.md`.
- Public API: a breaking change, approved by the owner. 41 operations are removed. The `PATCH /v1/organizations/{org}`
  contract changes: its 202 (proposal) and 409 `sponsor_proposal_pending` answers are removed, the request field
  `replace_pending_proposal` is removed, and 422 `sponsor_must_be_caller` is added. Nothing in production depends on
  them (owner, 2026-10-27). QACOBench uses none of them (`docs/API_DEPRECATIONS.md`).
- Migration: irreversible for the deleted report rows. The downgrade recreates the two tables empty (design.md §6).
  Container start applies `alembic upgrade head` (`req~lab-deployment-migrate-on-start~1`), so a lab or preview
  database with retired rows must be exported first, or the gateway does not start (design.md §6.4).
- Risks: design.md §8.

## Out of scope

- The organization creation rule (`POST /v1/organizations`: an administrator may name another sponsor) and the
  reassignment of sponsorship to the next OWNER when an account is deleted. Both stay as they are. Whether the
  caller-only rule extends to them is an open question (design.md §10, Q2).
- Package import (`/package`): it is unchanged, including its import of draft reports and of publications of versions
  that are already published (design.md §10, Q1).
- `/p/{id}` and `/c/{id}` permanent links: they are not implemented. ROADMAP M3.5 plans them. This change names the
  existing `/v1/resolve/{kind}/{digest}` links.
- A creator of new publications (ADR-0020 decision 3, "Publish" of study runs and collections): M6.5.
- Editing `openspec/specs/**`, `docs/adr/**`, ROADMAP, INTENT or any other change directory; archiving.
