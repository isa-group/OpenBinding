## ADDED Requirements

### Requirement: Removed operations answer like unrouted paths
`req~gateway-api-removed-operations-not-routed~1`
WHEN a client sends a request whose method and path template form a row of the removed-operations table, THE gateway SHALL answer with that row's status: 404 as for a path no route matches, or 405 with an `Allow` header that does not name the request's method.

Needs: impl, utest

#### Scenario: Every removed operation, without credentials
- **GIVEN** the gateway application built by `create_app`
- **WHEN** a client sends each of the 41 requests of the removed-operations table below once without credentials, with `isa-demo` for `{org}`, `p1` for `{project}`, `r1` for `{report}` and `{resource}`, and a random UUID for every other parameter
- **THEN** each response has the status of its row's "After" column
- **AND** each 404 response has the same status and body as `GET /v1/m96-never-routed`
- **AND** each 405 response has an `Allow` header that contains `GET` and does not contain the request's method

The removed-operations table (design.md §2.1):

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
| 10 | POST | `/v1/organizations/{org}/projects/{project}/reports` | 405 |
| 11 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/freeze` | 404 |
| 12 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/drafts` | 404 |
| 13 | PATCH | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| 14 | DELETE | `/v1/organizations/{org}/projects/{project}/reports/{report}` | 404 |
| 15 | POST | `/v1/organizations/{org}/projects/{project}/publications` | 405 |
| 16 | POST | `/v1/organizations/{org}/library` | 405 |
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
| 29 | POST | `/v1/organizations/{org}/projects/{project}/resources` | 405 |
| 30 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}` | 404 |
| 31 | POST | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` | 405 |
| 32 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| 33 | PATCH | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| 34 | DELETE | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | 404 |
| 35 | POST | `/v1/admin/organizations/{organization_id}/sponsor` | 404 |
| 36 | GET | `/v1/sponsor-proposals/{proposal_id}` | 404 |
| 37 | GET | `/v1/users/me/sponsor-proposals` | 404 |
| 38 | GET | `/v1/organizations/{org}/sponsor-proposals` | 404 |
| 39 | POST | `/v1/sponsor-proposals/{proposal_id}/accept` | 404 |
| 40 | POST | `/v1/sponsor-proposals/{proposal_id}/decline` | 404 |
| 41 | POST | `/v1/sponsor-proposals/{proposal_id}/cancel` | 404 |

#### Scenario: Removed operation with a valid session
- **GIVEN** an authenticated OWNER of organization `isa-demo` with project `p1`
- **WHEN** the client sends `GET /v1/analysis/sources`, `POST /v1/organizations/isa-demo/library` with `{"name": "d1", "kind": "Dataset"}` and `GET /v1/users/me/sponsor-proposals`
- **THEN** the answers are 404, 405 and 404
- **AND** no row is written to any table

#### Scenario: Removed operation with an API key
- **GIVEN** an API key holding `jobs:read` and `engines:execute`
- **WHEN** it sends `POST /v1/analysis/pareto`
- **THEN** the gateway answers 404 with the same body as `GET /v1/m96-never-routed`, and not 403 `insufficient_api_key_permission`

Evidence: `openbinding-gateway/tests/test_removed_operations.py`

### Requirement: Removed operations absent from the OpenAPI document
`req~gateway-api-removed-operations-not-documented~1`
THE gateway's OpenAPI document and the committed `docs/openapi.json` SHALL contain no operation whose method and path template form a row of the removed-operations table (requirement "Removed operations answer like unrouted paths").

Needs: impl, utest

#### Scenario: Generated document
- **GIVEN** the OpenAPI document the application generates
- **WHEN** the test looks up each of the 41 `(method, path template)` rows under `paths`
- **THEN** none is present
- **AND** the paths `/v1/analysis/sources`, `/v1/sponsor-proposals/{proposal_id}` and `/v1/users/me/sponsor-proposals` are absent from `paths` altogether

#### Scenario: Snapshot refreshed
- **GIVEN** the committed `docs/openapi.json`
- **WHEN** `python tools/dump_openapi.py --check` runs
- **THEN** it passes
- **AND** none of the 41 `(method, path template)` rows appears under `paths` in the file

Evidence: `openbinding-gateway/tests/test_removed_operations.py`; `openbinding-gateway/tools/dump_openapi.py`

### Requirement: Kept operations of the retired areas
`req~gateway-api-kept-retired-area-operations~1`
THE gateway SHALL keep routing and documenting the 12 operations of the kept-operations table with the behaviour they had before this change.

Needs: utest

#### Scenario: Routed and documented
- **GIVEN** the gateway application built by `create_app`
- **WHEN** the test collects the `(method, path_format)` pairs of the application's routes and the operations of its OpenAPI document
- **THEN** both contain each of the 12 rows of the kept-operations table below

The kept-operations table (design.md §2.2):

| # | Method | Path template |
|---|---|---|
| B1 | GET | `/v1/organizations/{org}/projects/{project}/reports` |
| B2 | GET | `/v1/organizations/{org}/library` |
| B3 | GET | `/v1/artifacts/{artifact_id}/versions` |
| B4 | GET | `/v1/artifacts/{artifact_id}/versions/{version_id}/content` |
| B5 | POST | `/v1/artifacts/resolve` |
| B6 | GET | `/v1/organizations/{org}/projects/{project}/resources` |
| B7 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` |
| K1 | GET | `/v1/jobs/{job_id}/analysis/neighborhood` |
| K2 | GET | `/v1/organizations/{org}/projects/{project}/publications` |
| K3 | DELETE | `/v1/organizations/{org}/projects/{project}/publications/{publication}` |
| K4 | GET | `/v1/explore/publications` |
| K5 | GET | `/v1/resolve/{kind}/{digest_value}` |

#### Scenario: Existing tests keep passing
- **GIVEN** this change's diff
- **WHEN** the gateway suite runs
- **THEN** `test_binding_analysis.py` and the tests of B1 to B7 and K2 to K5 in `test_b3_public_read.py`, `test_b2_resolve_urls.py` and `test_citations.py` under `openbinding-gateway/tests/` pass, with their assertions unchanged and only their setup moved off removed routes

Evidence: `openbinding-gateway/tests/test_removed_operations.py`; the gateway suite (G5)

### Requirement: No retirement headers
`req~gateway-api-no-retirement-headers~1`
THE gateway SHALL send neither a `Deprecation` header nor a `Sunset` header on any response to a request whose path is not `/v1/pricing`, `/v1/pricing/catalog` or `/v1/pricing/current`.

Needs: impl, utest

#### Scenario: Former retired path and kept paths
- **GIVEN** the gateway application built by `create_app`
- **WHEN** a client sends `GET /v1/analysis/sources`, `GET /v1/organizations/isa-demo/projects/p1/resources`, `GET /health` and `GET /v1/explore/publications` without credentials
- **THEN** no response carries `Deprecation` or `Sunset`

#### Scenario: OpenAPI declares no retirement header
- **GIVEN** the OpenAPI document the application generates
- **WHEN** the test reads `components/headers` and every response object
- **THEN** no `Deprecation` or `Sunset` header is declared outside the operations of the three pricing paths

Evidence: `openbinding-gateway/tests/test_removed_operations.py`

### Requirement: Exposed response headers
`req~gateway-api-cors-exposed-headers~1`
WHEN the gateway answers a request that carries an allowed `Origin`, THE gateway SHALL list exactly `Retry-After`, `ETag`, `Location`, `Content-Disposition`, `Digest` and `Idempotency-Key` in `Access-Control-Expose-Headers`.

Needs: impl, utest

#### Scenario: Cross-origin call
- **GIVEN** an allowed origin `http://localhost:5173` in `CORS_ALLOW_ORIGINS`
- **WHEN** a client sends `GET /health` with that `Origin`
- **THEN** `Access-Control-Expose-Headers` holds those six names and no other
- **AND** neither `Deprecation` nor `Sunset` is listed

Evidence: `openbinding-gateway/tests/test_b2_cors.py`

### Requirement: Record of removed operations
`req~gateway-api-removed-operations-page~1`
THE repository SHALL keep `docs/API_DEPRECATIONS.md` as the record of removed operations, listing each of the 41 rows of the removed-operations table as `METHOD path` under a heading that states its removal in M9.6.

Needs: utest

#### Scenario: Page complete
- **GIVEN** `docs/API_DEPRECATIONS.md` after this change
- **WHEN** the gateway unit test reads it
- **THEN** each of the 41 rows appears as `METHOD path`, for example `GET /v1/users/me/sponsor-proposals`
- **AND** no list entry is a kept operation, for example `GET /v1/organizations/{org}/projects/{project}/reports`
- **AND** the page contains neither `Sunset:` nor the text `not set yet`

Evidence: `openbinding-gateway/tests/test_removed_operations.py`
