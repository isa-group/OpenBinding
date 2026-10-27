# API deprecations

Operations of the gateway API that are deprecated and will be removed. Each one answers with the header
`Deprecation: @1792627200` (2026-10-22T00:00:00Z, RFC 9745) and is marked `deprecated` in
[`openapi.json`](openapi.json). Their behaviour is unchanged until they are removed.

**Deprecation date:** 2026-10-22 for every operation below.

**Sunset:** not set yet. The R1 release sets it to the R1 release date plus 90 days, and from then on these operations
also answer with a `Sunset` header (RFC 8594).

Nothing is removed before a release that sends both headers has shipped and the Sunset date has passed. QACOBench uses
none of these operations. The developer tools `tools/verify_analysis.py` and the hint printed by `tools/seed_dev.py`
leave with the removal.

## Decision-space workspace

Replacement: none in the API. The trade-off set of a multi-objective run moves to the run and study pages.

- `GET /v1/analysis/sources`
- `POST /v1/analysis/query`
- `POST /v1/analysis/candidate`
- `POST /v1/analysis/export`
- `POST /v1/analysis/reports`
- `POST /v1/analysis/pareto`
- `GET /v1/analysis/pareto/{task_id}`
- `POST /v1/analysis/pareto/{task_id}/cancel`

## Report editor

Replacement: none yet. Published results of study runs and collections.

- `GET /v1/organizations/{org}/projects/{project}/reports/{report}`
- `POST /v1/organizations/{org}/projects/{project}/reports`
- `POST /v1/organizations/{org}/projects/{project}/reports/{report}/freeze`
- `POST /v1/organizations/{org}/projects/{project}/reports/{report}/drafts`
- `PATCH /v1/organizations/{org}/projects/{project}/reports/{report}`
- `DELETE /v1/organizations/{org}/projects/{project}/reports/{report}`
- `POST /v1/organizations/{org}/projects/{project}/publications`

## Library catalogue

Replacement: none. Problems are versioned as a whole, and the artifact store stays internal.

- `POST /v1/organizations/{org}/library`
- `GET /v1/artifacts/{artifact_id}`
- `PATCH /v1/artifacts/{artifact_id}`
- `GET /v1/artifacts/{artifact_id}/versions/{version_id}`
- `GET /v1/artifacts/{artifact_id}/drafts`
- `POST /v1/artifacts/{artifact_id}/drafts`
- `PUT /v1/artifacts/{artifact_id}/drafts/{draft_id}`
- `POST /v1/artifacts/{artifact_id}/drafts/{draft_id}/seal`
- `POST /v1/artifacts/{artifact_id}/versions/{version_id}/publish`
- `POST /v1/artifacts/{artifact_id}/versions/{version_id}/withdraw`

## Project library

Replacement: none. Problems are versioned as a whole, and the artifact store stays internal.

- `PUT /v1/organizations/{org}/projects/{project}/library/{artifact_id}`
- `GET /v1/organizations/{org}/projects/{project}/library`
- `DELETE /v1/organizations/{org}/projects/{project}/library/{artifact_id}`

## Project resources

Replacement: none. Problem versions and collections.

- `POST /v1/organizations/{org}/projects/{project}/resources`
- `GET /v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}`
- `POST /v1/organizations/{org}/projects/{project}/resources/{resource}/revisions`
- `GET /v1/organizations/{org}/projects/{project}/resources/{resource}`
- `PATCH /v1/organizations/{org}/projects/{project}/resources/{resource}`
- `DELETE /v1/organizations/{org}/projects/{project}/resources/{resource}`

## Sponsorship

Replacement: none. Administrators assign the RESEARCH or LAB plan in SPACE.

- `POST /v1/admin/organizations/{organization_id}/sponsor`
- `GET /v1/sponsor-proposals/{proposal_id}`
