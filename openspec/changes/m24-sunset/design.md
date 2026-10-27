# Design: m24-sunset

Sources: `docs/agent-work/m24-sunset/intake.md` §2–§4 (inventory and sketch, code at `00f653ef`),
`docs/agent-work/m24-sunset/crp-draft.md`, `docs/agent-work/m24-sunset/handoff.md`. This design replaces the
intake's sketch where the owner's answers changed it (§1, §9).

## 1. Owner decisions (CRP answers)

Request 1, `crp-ob-m24-sunset-scope` (which operations get the headers). Answer, as relayed with the S0 task:

> scope = option A, the Deprecation header goes only on the 36 class-A operations with no caller left; the 12
> class-B operations stay unmarked and a test pins that no kept screen calls a marked operation.

Request 2, `crp-ob-m24-sunset-date` (the Sunset date). Answer, as relayed with the S0 task:

> Sunset date = option D: NO fixed Sunset date in the code; the R1 release PR (owner-merged) will set R1 date + 90
> days, so until then the 36 operations send Deprecation alone (Deprecation: @1792627200).

What follows from the answers:

- The table holds the 36 class-A rows of §2.1, and no class-B row (`req~gateway-api-retired-operation-set~1`).
- No date is pinned in this change. The Sunset constant ships empty (`None`), and no response carries `Sunset`
  (`req~gateway-api-retired-operation-no-sunset~1`). The R1 release PR records the date (§5).
- M9.6 removes nothing until a release carrying both headers has shipped **and** the Sunset has passed
  (`req~gateway-api-retired-operation-removal-gate~1`).

## 2. The operations

Path templates are the FastAPI route templates (`path_format`) at `00f653ef`. Their evidence (route file and line,
and caller searches) is in `intake.md` §2.

### 2.1 Class A: the table (36 rows)

| # | Method | Path template | Area |
|---|---|---|---|
| 1 | GET | `/v1/analysis/sources` | decision-space workspace |
| 2 | POST | `/v1/analysis/query` | decision-space workspace |
| 3 | POST | `/v1/analysis/candidate` | decision-space workspace |
| 4 | POST | `/v1/analysis/export` | decision-space workspace (streaming) |
| 5 | POST | `/v1/analysis/reports` | decision-space workspace |
| 6 | POST | `/v1/analysis/pareto` | decision-space workspace |
| 7 | GET | `/v1/analysis/pareto/{task_id}` | decision-space workspace |
| 8 | POST | `/v1/analysis/pareto/{task_id}/cancel` | decision-space workspace |
| 9 | GET | `/v1/organizations/{org}/projects/{project}/reports/{report}` | report editor |
| 10 | POST | `/v1/organizations/{org}/projects/{project}/reports` | report editor |
| 11 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/freeze` | report editor |
| 12 | POST | `/v1/organizations/{org}/projects/{project}/reports/{report}/drafts` | report editor |
| 13 | PATCH | `/v1/organizations/{org}/projects/{project}/reports/{report}` | report editor |
| 14 | DELETE | `/v1/organizations/{org}/projects/{project}/reports/{report}` | report editor |
| 15 | POST | `/v1/organizations/{org}/projects/{project}/publications` | report editor |
| 16 | POST | `/v1/organizations/{org}/library` | library catalogue |
| 17 | GET | `/v1/artifacts/{artifact_id}` | library catalogue |
| 18 | PATCH | `/v1/artifacts/{artifact_id}` | library catalogue |
| 19 | GET | `/v1/artifacts/{artifact_id}/versions/{version_id}` | library catalogue |
| 20 | GET | `/v1/artifacts/{artifact_id}/drafts` | library catalogue |
| 21 | POST | `/v1/artifacts/{artifact_id}/drafts` | library catalogue |
| 22 | PUT | `/v1/artifacts/{artifact_id}/drafts/{draft_id}` | library catalogue |
| 23 | POST | `/v1/artifacts/{artifact_id}/drafts/{draft_id}/seal` | library catalogue |
| 24 | POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/publish` | library catalogue |
| 25 | POST | `/v1/artifacts/{artifact_id}/versions/{version_id}/withdraw` | library catalogue |
| 26 | PUT | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` | project library |
| 27 | GET | `/v1/organizations/{org}/projects/{project}/library` | project library |
| 28 | DELETE | `/v1/organizations/{org}/projects/{project}/library/{artifact_id}` | project library |
| 29 | POST | `/v1/organizations/{org}/projects/{project}/resources` | project resources |
| 30 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions/{revision}` | project resources |
| 31 | POST | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` | project resources |
| 32 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | project resources |
| 33 | PATCH | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | project resources |
| 34 | DELETE | `/v1/organizations/{org}/projects/{project}/resources/{resource}` | project resources |
| 35 | POST | `/v1/admin/organizations/{organization_id}/sponsor` | sponsorship |
| 36 | GET | `/v1/sponsor-proposals/{proposal_id}` | sponsorship |

### 2.2 Class B: kept screens still call them (12, never in the table)

| # | Method | Path template | Kept caller (`intake.md` §2) |
|---|---|---|---|
| B1 | GET | `/v1/organizations/{org}/projects/{project}/reports` | `pages/Project/projectData.ts:38`, `pages/Reports/ProjPublications.tsx:66` |
| B2 | GET | `/v1/organizations/{org}/library` | `StudyBuilder.tsx:46`, `ArtifactVersionPicker.tsx:24` |
| B3 | GET | `/v1/artifacts/{artifact_id}/versions` | `StudyDetail.tsx:161`, `ArtifactVersionPicker.tsx:29` |
| B4 | GET | `/v1/artifacts/{artifact_id}/versions/{version_id}/content` | `StudyBuilder.tsx:92,95` |
| B5 | POST | `/v1/artifacts/resolve` | `CaseRevision.tsx:238` through `api/cases.ts:54` |
| B6 | GET | `/v1/organizations/{org}/projects/{project}/resources` | `pages/Resources/resourceData.ts:7,31` |
| B7 | GET | `/v1/organizations/{org}/projects/{project}/resources/{resource}/revisions` | `resourceData.ts:10` |
| B8 | GET | `/v1/users/me/sponsor-proposals` | `SponsorRequestsForYou.tsx:88`, `NotificationDropdown.tsx:52` |
| B9 | GET | `/v1/organizations/{org}/sponsor-proposals` | `OrgSettings.tsx:61` |
| B10 | POST | `/v1/sponsor-proposals/{proposal_id}/accept` | `SponsorRequestsForYou.tsx:39` |
| B11 | POST | `/v1/sponsor-proposals/{proposal_id}/decline` | `SponsorRequestsForYou.tsx:39` |
| B12 | POST | `/v1/sponsor-proposals/{proposal_id}/cancel` | `OrgSettings.tsx:174` |

### 2.3 Frontend client bindings of class-A operations (dead code, removed in M9.6)

These are the names the no-kept-caller scan looks for (`req~gateway-api-retired-operation-no-kept-caller~1`). They
are read from `frontend/src` at `00f653ef`.

| Defining module | Binding | Rows |
|---|---|---|
| `analysis/archive.ts:89` | `analysisApi` (any member) | 1–8 |
| `api/platform.ts:398` | `platformApi.report`, `.createReport`, `.freezeReport`, `.createReportDraft`, `.updateReport`, `.deleteReport`, `.publishReport` | 9–15 |
| `api/platform.ts:398` | `platformApi.createResource`, `.createResourceRevision`, `.resource`, `.updateResource`, `.deleteResource` | 29, 31–34 |
| `api/libraryItems.ts:26` | `libraryItemsApi.create`, `.item`, `.rename`, `.drafts`, `.createDraft`, `.saveDraft`, `.seal`, `.publish`, `.withdraw`, `.associate`, `.projectItems`, `.dissociate` | 16–18, 20–28 |
| `api/library.ts:21` | `libraryApi.drafts` | 20 |
| `api/client.ts:1302` | `adminTransferSponsor` (a method of `apiClient`) | 35 |

Rows 19, 30 and 36 have no client function. The kept members of the same objects are not listed, because they serve
class-B operations: `platformApi.reports`, `.resources` and `.resourceRevisions`, `libraryItemsApi.list`, `.versions`,
`.content` and `.resolve`, and `libraryApi.list`, `.versions` and `.content`. The scan matches `<object>.<member>` with
a word boundary after the member, so `platformApi.report` does not match `platformApi.reports`. It covers every
`.ts` and `.tsx` file under `frontend/src` except the defining modules above, `*.test.ts(x)` files and
`frontend/src/test/**`. A destructured alias (`const { report } = platformApi`) is not detected. That limit is
accepted: no such pattern exists today, and review catches a new one.

## 3. Decisions

- **D1 `core/deprecation.py`**, not `app/` or `shared/`. Reason: `tests/test_modules_skeleton.py:97-110` requires
  `app`, `shared` and `modules` to hold only `__init__.py`, and `:125-127` forbids `main.py` from importing them.
  Moving the module is M9.2 work.
- **D2 One central table and one pure ASGI middleware**, not `deprecated=True` and a header dependency on each
  route. Reasons: a dependency cannot add headers to responses a route returns itself (`JSONResponse` and
  `StreamingResponse` at `analysis.py:306,327`) or to error responses. The table also keeps the R1 route files
  (`admin.py`, `organizations.py`, `sponsor_proposals.py`; `.agentic/project.yaml:108`) untouched, as well as M4.3
  C3's `sponsor_proposals.py` (`docs/agent-work/m4-plans-slices/handoff.md:59`). Options considered: a per-route
  decorator (it misses error and direct responses, and touches five route files), and a `BaseHTTPMiddleware` (it
  buffers streaming bodies and runs in another task).
- **D3 Route matching through `scope["route"]`.** FastAPI's `APIRoute.matches` puts `route` into the child scope on
  a full or partial match, and Starlette's `Router.app` copies the child scope into the shared scope dict with
  `scope.update(child_scope)` before the endpoint runs. Lookups read `fastapi/routing.py` at tag 0.141.1 and
  `starlette/routing.py` at tag 1.3.1, which match `uv.lock:516,2122`. Both were summarized reads, so confidence is
  medium. The middleware reads `scope.get("route")` when `http.response.start` passes through its wrapped `send`,
  and the key is `(scope["method"], route.path_format)`. It uses the request method and not the route's methods,
  because a 405 is a partial match that also sets `route`. S1 pins 2xx, 4xx, streaming and 405. If S1 shows the key
  absent at `http.response.start`, the fallback is to match `scope["path"]` against the compiled `path_regex` of the
  app routes named by the table, in the same module, with no change to the requirements. No middleware that copies
  the scope dict sits between this middleware and the router (S2 checks the order in `main.py:349-360`).
- **D4 `Deprecation: @1792627200`**, the constant 2026-10-22T00:00:00Z, the owner's retirement decision (ADR-0020
  line 5). It is not the merge day, so a test can pin it. RFC 9745 §2.1 allows a date in the past.
- **D5 No `Link` header.** No class-A operation has an API successor, and there is no public documentation URL yet.
  `rel="deprecation"` pointing at the published `API_DEPRECATIONS.md` can come later as a new requirement.
- **D6 No feature flag.** The headers are additive, and reverting the PR is the rollback.
- **D7 The Sunset date is one code constant**, `RETIRED_OPERATIONS_SUNSET: datetime.date | None = None` in
  `core/deprecation.py`, and not a setting or an environment variable. Reasons: the date must be the same on every
  deployment; `docs/openapi.json` is generated from code, so a per-deployment value would make the snapshot disagree
  with production; and the owner sees the date in the diff of the release PR they merge. The header value is derived
  from it: that day at 23:59:59 GMT in the IMF-fixdate form (RFC 9110 §5.6.7, the HTTP-date form RFC 8594 §3
  requires). Nothing else may hold the date. The middleware, the OpenAPI annotation and the floor test read this
  constant, and `docs/API_DEPRECATIONS.md` states it.
- **D8 The no-kept-caller test runs in the gateway suite.** It sits in the S1 file, beside the literal table it
  guards. Reasons: one capability, one red/green run, and the factory's gateway checks already run that file. The
  monorepo always has `frontend/src`. If the directory is missing, the test fails and does not skip, so the guard
  cannot pass vacuously.
- **D9 OpenAPI declares exactly what is sent.** `Deprecation` is declared on every response of the 36 operations.
  `Sunset` and its component are declared only while the constant holds a date, so the document never promises a
  header the gateway does not send. As a result, the R1 release PR regenerates `docs/openapi.json` (§5).
- **D10 Both header names are exposed to browsers now**, `Sunset` included. An exposed name that is not sent costs
  nothing, and the release PR stays free of `core/settings.py` edits.

## 4. Behaviour

- **Responses that carry `Deprecation`:** every response to a request whose `(method, path template)` is a table row
  and that reaches `http.response.start` inside the middleware. That covers 2xx, 3xx, and the 4xx raised by
  dependencies, `HTTPException`, request validation or the `BimError` handlers. The header is added to the start
  message, so streaming bodies (#4) are never buffered or altered.
- **Responses that do not carry it:** unmatched paths (404), a method that has no row for its path (405, for
  example `PUT /v1/analysis/sources`), CORS preflights (answered by the CORS middleware before routing), and a header
  the endpoint already set, which the middleware never duplicates (no route sets one today). Not guaranteed either
  way, and not tested: 413s from `BodyLimitMiddleware` and 500s from Starlette's outermost `ServerErrorMiddleware`
  (`main.py:345`). Both arise outside the middleware's `send` or before routing.
- **`HEAD`:** the lookup uses the request method as it is. A `HEAD` request is not a row, so it gets no header. No
  client uses `HEAD` on these operations.
- **Cost:** one dict lookup per response.
- **Placement in `main.py`:** the middleware is registered with `app.add_middleware` in `create_app` (D3 order),
  and `openapi_with_security_contract` (`main.py:396`) calls `annotate_retired_operations(document)` from
  `core/deprecation.py`. That function sets `deprecated: true` and the header references on the table's
  operations, and adds `components/headers/Deprecation`, plus `Sunset` while a date is recorded. The header objects
  are a string schema with a description naming RFC 9745 or RFC 8594, and the examples `@1792627200` and
  `Thu, 15 Apr 2027 23:59:59 GMT`.
- **Traceability:** the table, the middleware and the annotation carry `[impl->req~gateway-api-…~1]` tags. The S1
  and S2 tests carry `[utest->…]`.

## 5. Recording the Sunset date: the R1 release PR

The R1 release PR (release branch into `main`, prepared by the release role, merged only by the owner) carries this
diff, and nothing else for this change:

1. `core/deprecation.py`: `RETIRED_OPERATIONS_SUNSET = None` becomes `datetime.date(Y, M, D)`, the R1 release date
   plus 90 days. The R1 release date is the date of the R1 version entry of `CHANGELOG.md` in the same PR.
   Example: R1 dated 2027-01-15 gives `date(2027, 4, 15)` and `Sunset: Thu, 15 Apr 2027 23:59:59 GMT`.
2. `docs/openapi.json`, regenerated with `tools/dump_openapi.py`. It gains the `Sunset` header on every response of
   the 36 operations and `components/headers/Sunset` (D9). The G7 snapshot check fails until this is done.
3. `openbinding-gateway/tests/test_retired_operations_deprecation.py`: the single literal `EXPECTED_SUNSET = None`
   becomes the header value of item 1.
4. `docs/API_DEPRECATIONS.md`: the Sunset line states the date.

The release MRP shows the arithmetic (release date + 90 days = Sunset). If the owner merges after the date written
in the R1 entry, the release role moves both dates before the merge, so the notice from the actual release is never
shorter than 90 days. The commit returns to `develop` with the release branch's back-merge, like any release-branch
fix. `req~gateway-api-retired-operation-sunset-floor~1` makes any recorded date earlier than 2027-01-20 (the
Deprecation date plus 90 days) fail the gateway suite. That also keeps RFC 9745 §4: the Sunset is not earlier than
the Deprecation.

**Removal gate (M9.6).** The operations stay until both conditions hold: a release carrying `Deprecation` and
`Sunset` has been merged into `main`, and the recorded Sunset date has passed. M9.6 then needs its own owner CRP.

## 6. `docs/API_DEPRECATIONS.md`

The page has one section per area, listing its operations as `METHOD path` with the Deprecation date (2026-10-22).
It states the Sunset: until R1, the text "not set yet: the R1 release sets it to the R1 release date plus 90 days",
then the date. Each area names its replacement in the platform, or says there is none:

| Area | Replacement |
|---|---|
| decision-space workspace (rows 1–8) | none in the API. The trade-off set of a multi-objective run moves to the run and study pages (ADR-0020 decision 3) |
| report editor (9–15) | none yet. Published results of study runs and collections (M6.5) |
| library catalogue and project library (16–28) | none. Problems are versioned as a whole, and the artifact store stays internal (ADR-0020 decision 3) |
| project resources (29–34) | none. Problem versions and collections |
| sponsorship (35–36) | none. Administrators assign RESEARCH or LAB in SPACE (ADR-0020 decision 3, M4.3) |

The page also states that QACOBench uses none of these operations, and that the developer tools
`tools/verify_analysis.py` and the hint printed by `tools/seed_dev.py` leave with M9.6.

## 7. Other changes affected

- `req~frontend-retire-gateway-untouched~1` (`openspec/changes/m24-retire-screens/specs/frontend-workspace/spec.md:263-285`)
  says no response of `/v1/analysis/*` carries the headers. Its scope is the diffs of the screen slices, and no test
  asserts it (no `Deprecation` under `openbinding-gateway/tests` at `00f653ef`). This change ends that clause for the
  gateway. The m24 archive task modifies or removes the requirement, because an unarchived change cannot be modified
  from here.
- `m43-plans-pricing-route` plans `Deprecation` and `Link` on `/v1/pricing*` with its own date
  (`design.md:276`). Whichever change lands second reuses `core/deprecation.py`, with a separate table for the
  pricing routes (its own value and `Link`). The 36-row set of this change does not grow. The "deprecated before this
  change" set of `req~gateway-api-retired-operation-openapi~1` is a literal in the S1 test: `{getPricingDocument}`
  today. It gains `getPricingCatalog` and `getCurrentPricing` if m43 S1 merges first. If m43 merges second, its S1
  updates that literal.

## 8. Risks

- **A kept screen calls a marked operation.** Class B is excluded, and the no-kept-caller scan pins the bindings of
  §2.3.
- **R1 slips, so Deprecation runs alone for longer.** This is the accepted cost of option D. Removal still waits for
  both conditions of §5.
- **The release PR forgets the date.** `Sunset` stays absent, which is safe but delays M9.6. The release checklist
  (tasks.md R1) names the four edits, and the docs page states the open item.
- **A wrong date** (earlier than the Deprecation date plus 90 days). The floor test fails. A later date is a
  compatible change; an earlier one is not.
- **The D3 assumption.** Medium confidence, pinned by S1, with a fallback in the same module.
- **A middleware on every response.** One lookup and no buffering. The arch-reviewer is on the S2 panel.
- **Data:** none changes. Report drafts, workspaces, sponsorship proposals and library drafts stay until M9.6.

## 9. Changes from the intake

- §3 "Wire values": the `Sunset: <CRP-2 date>` value is gone. This change sends `Deprecation` alone, and the Sunset
  comes from the constant of D7, set in the R1 release PR (§5).
- §4 requirement list: rewritten as the 14 requirements of `specs/gateway-api/spec.md`. The header requirement is
  split into a Deprecation requirement, a Sunset requirement (while a date is recorded), a no-Sunset requirement (this
  change's state), a floor and a release-PR rule. The removal gate, the no-kept-caller scan and the docs page are new.
- §4 S1 outline: tests 1, 2 and 5 assert `Deprecation` and the absence of `Sunset` through `EXPECTED_SUNSET`. Old
  test 7 (Sunset ≥ Deprecation) becomes the S2 floor test. The no-kept-caller scan is added (tasks.md S1).
- §5 check 1: the argv names `m24-sunset`.
