## ADDED Requirements

### Requirement: Retired-operations table
THE gateway SHALL hold one retired-operations table whose rows are exactly the 36 operations listed below, each identified by its HTTP method and its route path template.

`req~gateway-api-retired-operation-set~1`

Needs: impl, utest

| # | Method | Path template |
|---|---|---|
| 1 | GET | `/v1/analysis/sources` |
| 2 | POST | `/v1/analysis/query` |
| 3 | POST | `/v1/analysis/candidate` |
| 4 | POST | `/v1/analysis/export` |
| 5 | POST | `/v1/analysis/reports` |
| 6 | POST | `/v1/analysis/pareto` |
| 7 | GET | `/v1/analysis/pareto/{task_id}` |
| 8 | POST | `/v1/analysis/pareto/{task_id}/cancel` |
| 9 | GET | `/v1/organizations/{org}/projects/{project}/reports/{report}` |
| 10 | POST | `/v1/organizations/{org}/projects/{project}/reports` |
| 11 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/freeze` |
| 12 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/drafts` |
| 13 | PATCH | `/v1/organizations/{org}/projects/{project}/reports/{report}` |
| 14 | DELETE | `/v1/organizations/{org}/projects/{project}/reports/{report}` |
| 15 | POST | `/v1/organizations/{org}/projects/{project}/publications` |
| 16 | POST | `/v1/organizations/{org}/library` |
| 17 | GET | `/v1/artifacts/{artifact_id}` |
| 18 | PATCH | `/v1/artifacts/{artifact_id}` |
| 19 | GET | `/v1/artifacts/{artifact_id}/versions/{version_id}` |
| 20 | GET | `/v1/artifacts/{artifact_id}/drafts` |
| 21 | POST | `/v1/artifacts/{artifact_id}/drafts` |
| 22 | PUT | `/v1/artifacts/{artifact_id}/drafts/{draft_id}` |
| 23 | POST | `/v1/artifacts/{artifact_id}/drafts/{draft_id}/seal` |
| 24 | POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/publish` |
| 25 | POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/withdraw` |
| 26 | PUT | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` |
| 27 | GET | `/v1/organizations/{org}/projects/{project}/library` |
| 28 | DELETE | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` |
| 29 | POST | `/v1/organizations/{org}/projects/{project}/resources` |
| 30 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}` |
| 31 | POST | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` |
| 32 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}` |
| 33 | PATCH | `/v1/organizations/{org}/projects/{project}/resources/{resource}` |
| 34 | DELETE | `/v1/organizations/{org}/projects/{project}/resources/{resource}` |
| 35 | POST | `/v1/admin/organizations/{organization_id}/sponsor` |
| 36 | GET | `/v1/sponsor-proposals/{proposal_id}` |

#### Scenario: Every listed operation is a row
- **GIVEN** the gateway application built by `create_app`
- **WHEN** a client calls each of the 36 operations once without credentials, with `isa-demo` for `{org}`, `p1` for `{project}` and other slugs, and a random UUID for each parameter the route parses as a UUID
- **THEN** each of the 36 responses carries the header `Deprecation: @1792627200`

#### Scenario: Operations kept screens still call are not rows
- **GIVEN** the same application
- **WHEN** a client calls, without credentials, `GET /v1/organizations/isa-demo/projects/p1/reports`, `GET /v1/organizations/isa-demo/library`, `GET /v1/artifacts/{uuid}/versions`, `GET /v1/artifacts/{uuid}/versions/{uuid}/content`, `POST /v1/artifacts/resolve`, `GET /v1/organizations/isa-demo/projects/p1/resources`, `GET /v1/organizations/isa-demo/projects/p1/resources/r1/revisions`, `GET /v1/users/me/sponsor-proposals`, `GET /v1/organizations/isa-demo/sponsor-proposals`, and `POST /v1/sponsor-proposals/{uuid}/accept`, `/decline` and `/cancel`
- **THEN** none of the 12 responses carries a `Deprecation` header or a `Sunset` header

#### Scenario: Other kept operations are not rows
- **GIVEN** the same application
- **WHEN** a client calls `GET /health`, `GET /v1/organizations`, `GET /v1/organizations/isa-demo/projects/p1/publications` and `DELETE /v1/organizations/isa-demo/projects/p1/publications/pub1`
- **THEN** none of the responses carries a `Deprecation` header or a `Sunset` header

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`; `openbinding-gateway/tests/test_deprecation_unit.py` (36 unique rows, each one a route of the application)

The owner chose this scope in CRP `crp-ob-m24-sunset-scope`, option A (design.md §1). Operations that a kept screen still calls join the table only in the change that moves their last screen off them.

### Requirement: Deprecation header on retired operations
WHEN the gateway sends a response to a request whose method and matched route path template form a row of the retired-operations table, THE gateway SHALL include the header `Deprecation: @1792627200` in that response, whatever its status code.

`req~gateway-api-retired-operation-deprecation~1`

Needs: impl, utest

#### Scenario: Refused without credentials
- **GIVEN** no `Authorization` header and no API key
- **WHEN** a client sends `GET /v1/analysis/sources`
- **THEN** the gateway answers 401
- **AND** the response carries `Deprecation: @1792627200`

#### Scenario: Successful read and create
- **GIVEN** an authenticated member of organization `isa-demo` with project `p1`
- **WHEN** the client sends `GET /v1/analysis/sources`, `POST /v1/organizations/isa-demo/library` with a valid item, `POST /v1/organizations/isa-demo/projects/p1/reports` with a valid report and `POST /v1/organizations/isa-demo/projects/p1/resources` with a valid resource
- **THEN** the answers are 200, 201, 201 and 201
- **AND** each response carries `Deprecation: @1792627200`

#### Scenario: Not found inside a matched route
- **GIVEN** an authenticated user
- **WHEN** the client sends `GET /v1/sponsor-proposals/{a random UUID}`
- **THEN** the gateway answers 404
- **AND** the response carries `Deprecation: @1792627200`

#### Scenario: Request validation error
- **GIVEN** any caller
- **WHEN** the client sends `GET /v1/artifacts/not-a-uuid`
- **THEN** the gateway answers 422
- **AND** the response carries `Deprecation: @1792627200`

#### Scenario: Streaming export
- **GIVEN** an authenticated user and an archive query the export accepts
- **WHEN** the client sends `POST /v1/analysis/export` with `format` `csv`
- **THEN** the response status is 200 and carries `Deprecation: @1792627200`
- **AND** the body bytes are the ones the export produced before this change

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`

`@1792627200` is 2026-10-22T00:00:00Z, the owner's retirement decision (ADR-0020), in the form of RFC 9745 §2.1.

### Requirement: No deprecation headers outside the table
IF a request does not form a row of the retired-operations table, THEN THE gateway SHALL send its response without a `Deprecation` header and without a `Sunset` header.

`req~gateway-api-retired-operation-no-match~1`

Needs: impl, utest

#### Scenario: Wrong method on a retired path
- **GIVEN** any caller
- **WHEN** a client sends `PUT /v1/analysis/sources` and `DELETE /v1/artifacts/{a random UUID}`
- **THEN** both answers are 405
- **AND** neither response carries `Deprecation` or `Sunset`

#### Scenario: Unknown path
- **GIVEN** any caller
- **WHEN** a client sends `GET /v1/analysis/does-not-exist`
- **THEN** the gateway answers 404
- **AND** the response carries neither `Deprecation` nor `Sunset`

#### Scenario: CORS preflight
- **GIVEN** an allowed origin `http://localhost:5173` in `CORS_ALLOW_ORIGINS`
- **WHEN** a client sends `OPTIONS /v1/analysis/sources` with that `Origin` and `Access-Control-Request-Method: GET`
- **THEN** the preflight response carries neither `Deprecation` nor `Sunset`

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`

### Requirement: Sunset header once a date is recorded
WHILE a Sunset date is recorded for the retired-operations table, WHEN the gateway sends a response to a request that forms a row of the table, THE gateway SHALL include the header `Sunset` whose value is that date at 23:59:59 GMT in the IMF-fixdate form of RFC 9110 §5.6.7.

`req~gateway-api-retired-operation-sunset~1`

Needs: impl, utest

#### Scenario: Date recorded
- **GIVEN** the Sunset date 2027-04-15 recorded for the table
- **WHEN** a client sends `GET /v1/analysis/sources` without credentials
- **THEN** the gateway answers 401
- **AND** the response carries `Sunset: Thu, 15 Apr 2027 23:59:59 GMT`
- **AND** the response still carries `Deprecation: @1792627200`

#### Scenario: Date recorded, class-B operation
- **GIVEN** the Sunset date 2027-04-15 recorded for the table
- **WHEN** a client sends `GET /v1/organizations/isa-demo/projects/p1/resources` without credentials
- **THEN** the response carries no `Sunset` header

Evidence: `openbinding-gateway/tests/test_deprecation_unit.py` (the recorded date replaced for the test)

### Requirement: No Sunset header before a date is recorded
WHILE no Sunset date is recorded for the retired-operations table, THE gateway SHALL send no `Sunset` header on any response.

`req~gateway-api-retired-operation-no-sunset~1`

Needs: impl, utest

#### Scenario: State shipped by this change
- **GIVEN** the gateway built from this change, whose recorded Sunset date is empty
- **WHEN** a client sends `GET /v1/analysis/sources` and `GET /health` without credentials
- **THEN** the first response carries `Deprecation: @1792627200` and no `Sunset` header
- **AND** the second response carries neither header

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py` (`EXPECTED_SUNSET = None`)

The owner chose this in CRP `crp-ob-m24-sunset-date`, option D (design.md §1). RFC 9745 allows `Deprecation` without `Sunset`.

### Requirement: Sunset date recorded by the R1 release
THE Sunset date of the retired-operations table SHALL be recorded only in the R1 release pull request into `main`, as the R1 release date plus 90 days.

`req~gateway-api-retired-operation-sunset-by-release~1`

#### Scenario: R1 release pull request
- **GIVEN** the R1 release pull request, whose R1 entry of `CHANGELOG.md` is dated 2027-01-15
- **WHEN** the release role prepares it
- **THEN** it records the Sunset date 2027-04-15 in the single constant of design.md D7
- **AND** it regenerates `docs/openapi.json`, sets `EXPECTED_SUNSET` to `Thu, 15 Apr 2027 23:59:59 GMT` and states the date in `docs/API_DEPRECATIONS.md`

#### Scenario: A pull request into develop before R1
- **GIVEN** a pull request into `develop` that records a Sunset date before R1 is released
- **WHEN** it is reviewed
- **THEN** the reviewer reports a blocker finding citing this requirement

#### Scenario: The release merge slips
- **GIVEN** an R1 release pull request whose R1 entry is dated 2027-01-15 and that is not merged on that day
- **WHEN** the release role updates it before the owner merges it
- **THEN** the R1 entry date and the recorded Sunset date move together, keeping 90 days between them

Evidence: the diff and the merge-readiness pack of the R1 release pull request, checked by the release role and the reviewer

No gateway code or test can check this rule (no `Needs:`). It is a constraint on which pull request carries the date. The lower bound is tested (requirement "Sunset date not earlier than the notice floor").

### Requirement: Sunset date not earlier than the notice floor
IF a Sunset date is recorded for the retired-operations table, THEN the recorded date SHALL be 2027-01-20 or later, that is, 90 days or more after the Deprecation date 2026-10-22.

`req~gateway-api-retired-operation-sunset-floor~1`

Needs: utest

#### Scenario: No date recorded
- **GIVEN** the gateway built from this change
- **WHEN** the unit test reads the recorded Sunset date
- **THEN** it is empty and the test passes

#### Scenario: Date below the floor
- **GIVEN** a recorded Sunset date of 2027-01-19
- **WHEN** the gateway unit tests run
- **THEN** the floor test fails, naming 2027-01-20

Evidence: `openbinding-gateway/tests/test_deprecation_unit.py`

The floor also keeps RFC 9745 §4: the Sunset is not earlier than the Deprecation.

### Requirement: Retired operations marked deprecated in OpenAPI
THE gateway's OpenAPI document SHALL mark `deprecated: true` on exactly the operations of the retired-operations table and the operations that were deprecated before this change.

`req~gateway-api-retired-operation-openapi~1`

Needs: impl, utest

#### Scenario: Deprecated set
- **GIVEN** the OpenAPI document the application generates
- **WHEN** the test collects every operation with `deprecated: true`
- **THEN** the collected set equals the 36 table operations plus `getPricingDocument`

#### Scenario: Snapshot fresh
- **GIVEN** the committed `docs/openapi.json`
- **WHEN** `python tools/dump_openapi.py --check` runs
- **THEN** it passes, and the 36 table operations carry `deprecated: true` in the file

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`; `openbinding-gateway/tools/dump_openapi.py`

The set "deprecated before this change" is a literal of the test (design.md §7).

### Requirement: Deprecation headers declared in OpenAPI
THE gateway's OpenAPI document SHALL declare, on every response of every operation of the retired-operations table, exactly the deprecation headers the gateway sends for it: `Deprecation`, and `Sunset` while a Sunset date is recorded.

`req~gateway-api-retired-operation-openapi-headers~1`

Needs: impl, utest

#### Scenario: No date recorded
- **GIVEN** the OpenAPI document the gateway built from this change generates
- **WHEN** the test reads every response object of `POST /v1/analysis/query`
- **THEN** each response declares the header `Deprecation` as a reference to `#/components/headers/Deprecation`
- **AND** none declares `Sunset`, and `components/headers` has no `Sunset` entry

#### Scenario: Date recorded
- **GIVEN** the Sunset date 2027-04-15 recorded for the table
- **WHEN** the OpenAPI document is generated
- **THEN** every response of each of the 36 table operations also declares `Sunset` as a reference to `#/components/headers/Sunset`

#### Scenario: Class-B operation
- **GIVEN** either state of the recorded date
- **WHEN** the test reads the responses of `GET /v1/organizations/{org}/library`
- **THEN** none declares `Deprecation` or `Sunset`

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`; `openbinding-gateway/tests/test_deprecation_unit.py` (recorded date)

### Requirement: Retired operations keep their behaviour
THE gateway SHALL answer requests to the operations of the retired-operations table with the status codes, bodies, authentication and permission checks they had before this change.

`req~gateway-api-retired-operation-unchanged~1`

Needs: utest

#### Scenario: Existing tests unedited
- **GIVEN** this change's diff
- **WHEN** the gateway suite runs
- **THEN** `test_binding_analysis.py`, `test_archive_analysis.py`, `test_apikey_analysis_scopes.py`, `test_artifact_library.py` and `test_b3_sponsor_proposals.py` under `openbinding-gateway/tests/` pass without being edited by the diff

#### Scenario: Status codes per area
- **GIVEN** the calls of the scenario "Successful read and create" and "Not found inside a matched route"
- **WHEN** their responses arrive
- **THEN** the status codes are 200, 201, 201, 201 and 404, as before this change

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`; the gateway suite (G5)

### Requirement: Deprecation headers readable by browsers
WHEN the gateway answers a request that carries an allowed `Origin`, THE gateway SHALL list `Deprecation` and `Sunset` in `Access-Control-Expose-Headers`.

`req~gateway-api-deprecation-headers-exposed~1`

Needs: impl, utest

#### Scenario: Cross-origin call to a retired operation
- **GIVEN** an allowed origin `http://localhost:5173` in `CORS_ALLOW_ORIGINS`
- **WHEN** a client sends `GET /v1/analysis/sources` with that `Origin` and no credentials
- **THEN** `Access-Control-Expose-Headers` contains `Deprecation` and `Sunset`
- **AND** it still contains `Retry-After`, `ETag`, `Location`, `Content-Disposition`, `Digest` and `Idempotency-Key`

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`

### Requirement: No kept screen calls a retired operation
THE frontend's non-test sources, outside the API client modules that define them, SHALL contain no reference to a client binding of an operation of the retired-operations table.

`req~gateway-api-retired-operation-no-kept-caller~1`

Needs: utest

#### Scenario: Sources at this change
- **GIVEN** every `.ts` and `.tsx` file under `frontend/src` except `*.test.ts`, `*.test.tsx`, `frontend/src/test/**` and the defining modules `analysis/archive.ts`, `api/platform.ts`, `api/libraryItems.ts`, `api/library.ts` and `api/client.ts`
- **WHEN** the test searches them for the bindings of design.md §2.3 (for example `analysisApi`, `platformApi.report`, `libraryItemsApi.seal`, `libraryApi.drafts` and `adminTransferSponsor`)
- **THEN** it finds none
- **AND** `platformApi.reports`, `libraryApi.versions` and the other bindings of class-B operations are not reported

#### Scenario: A screen starts calling a retired operation
- **GIVEN** a page under `frontend/src/pages/` that calls `platformApi.report(org, project, slug)`
- **WHEN** the test runs
- **THEN** it fails, naming the file and the binding `platformApi.report`

#### Scenario: Frontend sources missing
- **GIVEN** a checkout without `frontend/src`
- **WHEN** the test runs
- **THEN** it fails, and is not skipped

Evidence: `openbinding-gateway/tests/test_retired_operations_deprecation.py`

### Requirement: Retired operations served until the Sunset and a release
THE gateway SHALL keep serving every operation of the retired-operations table until a release whose responses on those operations carry both `Deprecation` and `Sunset` has been merged into `main` and the recorded Sunset date has passed.

`req~gateway-api-retired-operation-removal-gate~1`

#### Scenario: Sunset passed, no release with the headers
- **GIVEN** a recorded Sunset date in the past and no release merged into `main` that sends `Sunset`
- **WHEN** a change proposes to remove a table operation
- **THEN** the reviewer reports a blocker finding citing this requirement

#### Scenario: Release shipped, Sunset not passed
- **GIVEN** the R1 release merged into `main` with both headers, and a recorded Sunset date in the future
- **WHEN** a change proposes to remove a table operation
- **THEN** the reviewer reports a blocker finding citing this requirement

#### Scenario: Both conditions hold
- **GIVEN** the R1 release merged into `main` with both headers, and the recorded Sunset date passed
- **WHEN** M9.6 proposes the removal
- **THEN** the removal still needs its own owner CRP (ROADMAP M9.6) before any table operation is removed

Evidence: the M9.6 CRP and the merge-readiness pack of its pull request

No gateway code or test covers this requirement (no `Needs:`). It is a constraint on later diffs, checked by the reviewer and the coordinator.

### Requirement: Published deprecation page
THE repository SHALL publish `docs/API_DEPRECATIONS.md`, listing every operation of the retired-operations table as `METHOD path` with the Deprecation date 2026-10-22, the Sunset date or, while none is recorded, the statement that the R1 release sets it to the R1 release date plus 90 days, and the platform's replacement for its area or the word `none`.

`req~gateway-api-retired-operation-docs~1`

Needs: utest

#### Scenario: Page complete
- **GIVEN** `docs/API_DEPRECATIONS.md` in this change
- **WHEN** the unit test reads it
- **THEN** each of the 36 rows appears as `METHOD path`, for example `GET /v1/analysis/sources`
- **AND** the page contains `2026-10-22`
- **AND** no list entry of the page is exactly a class-B `METHOD path`, for example `GET /v1/organizations/{org}/projects/{project}/reports`

#### Scenario: No date recorded
- **GIVEN** no recorded Sunset date
- **WHEN** a reader opens the page
- **THEN** it says that the Sunset is not set yet and that the R1 release sets it to the R1 release date plus 90 days

Evidence: `openbinding-gateway/tests/test_deprecation_unit.py`; `docs/API_DEPRECATIONS.md`
