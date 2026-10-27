# Intake: M2.4 final step, `Deprecation` and `Sunset` on the endpoints of the retired screens

- Owner request: own-f2201fb4bca74fb2ab472d3334323acf · Decision record: ADR-0020 (decision 5) · Base: `00f653ef`
- INTENT objective: **O12, Surface** (journeys decide what exists, INTENT principle 12). ROADMAP M2.4 deliverable:
  "their endpoints answer with `Deprecation` and `Sunset` headers (CRP)" (`ROADMAP.md:69`). The removal is M9.6
  (`ROADMAP.md:190`) and is **not** part of this step.
- Proposed OpenSpec change id: `m24-deprecate-retired-endpoints` (capability `gateway-api`, ADDED requirements).
- Owner input needed before any slice merges: CRP-1 (which operations) and CRP-2 (Sunset date), see `crp-draft.md`.

## 1. Objective

Every operation that only the five retired screens used now answers with `Deprecation` and `Sunset`. Behaviour,
status codes, bodies, authentication and permissions do not change. API clients get one minor release of notice
before M9.6 removes the operations (ADR-0020 decision 5: "Screens go first, then endpoints, after one minor release
with `Deprecation` and `Sunset` headers (CRP)", `docs/adr/0020-smaller-platform.md:45-46`).

## 2. Endpoint inventory (code at `00f653ef`)

Paths are relative to `openbinding-gateway/src/openbinding_gateway/routes/`. Each line number is the line of the
route decorator. **Class A**: no caller is left in the platform after the five screen slices (PR #51, #53, #55,
#65, #66). **Class B**: a screen that stays still calls the operation (frontend evidence is given).

### 2.1 Decision-space workspace: router `/v1/analysis` (`analysis.py:38`)

| # | Operation | Where | Class |
|---|---|---|---|
| 1 | `GET /v1/analysis/sources` | `analysis.py:226` | A |
| 2 | `POST /v1/analysis/query` | `analysis.py:256` | A |
| 3 | `POST /v1/analysis/candidate` | `analysis.py:275` | A |
| 4 | `POST /v1/analysis/export` (streaming) | `analysis.py:296` | A |
| 5 | `POST /v1/analysis/reports` | `analysis.py:331` | A |
| 6 | `POST /v1/analysis/pareto` | `analysis.py:354` | A |
| 7 | `GET /v1/analysis/pareto/{task_id}` | `analysis.py:405` | A |
| 8 | `POST /v1/analysis/pareto/{task_id}/cancel` | `analysis.py:411` | A |

Evidence for class A: `frontend/src/analysis/archive.ts:89` (`analysisApi`) has no importer. Only types are
imported, by `components/BindingAnalysis/ArchiveChart.tsx:2`. Not in scope: `GET /v1/jobs/{id}/analysis/neighborhood`
(`api/client.ts:932`), which the run page's `BindingAnalysis` card still uses and which is not the workspace.

### 2.2 Report editor: router `/v1/organizations/{org}/projects/{project}` (`studies.py:86`)

| # | Operation (operation id) | Where | Class | Caller evidence |
|---|---|---|---|---|
| 9 | `GET …/reports/{report}` (`getReport`) | `studies.py:1202` | A | `platformApi.report` has no non-test caller |
| 10 | `POST …/reports` (`createReport`) | `studies.py:1226` | A | — |
| 11 | `POST …/reports/{report}/freeze` (`freezeReport`) | `studies.py:1259` | A | — |
| 12 | `POST …/reports/{report}/drafts` (`createReportDraft`) | `studies.py:1282` | A | — |
| 13 | `PATCH …/reports/{report}` (`updateReport`) | `studies.py:1300` | A | — |
| 14 | `DELETE …/reports/{report}` (`deleteReport`) | `studies.py:1335` | A | — |
| 15 | `POST …/publications` (`publishReport`) | `studies.py:1360` | A | its only screen, `PublishDialog`, went with slice 2 |
| B1 | `GET …/reports` (`listReports`) | `studies.py:1188` | **B** | `pages/Project/projectData.ts:38`, used by `ProjectOverview.tsx:262`, `ProjectSettings.tsx:92` and `ProjectPackage.tsx:52`; `pages/Reports/ProjPublications.tsx:66` |

Kept and out of scope: `GET …/publications` (`studies.py:1402`) and `DELETE …/publications/{publication}`
(`studies.py:1416`). `ProjPublications.tsx:66,81` uses them, and they belong to published results (M6.5).

### 2.3 Library catalogue: router `/v1` (`library.py:23`, no explicit operation ids)

| # | Operation | Where | Class | Caller evidence |
|---|---|---|---|---|
| 16 | `POST /v1/organizations/{org}/library` | `library.py:61` | A | `libraryItemsApi` (`api/libraryItems.ts:26`) has no non-test caller |
| 17 | `GET /v1/artifacts/{artifact_id}` | `library.py:84` | A | idem |
| 18 | `PATCH /v1/artifacts/{artifact_id}` | `library.py:93` | A | idem |
| 19 | `GET /v1/artifacts/{artifact_id}/versions/{version_id}` | `library.py:115` | A | idem |
| 20 | `GET /v1/artifacts/{artifact_id}/drafts` | `library.py:145` | A | `libraryApi.drafts` has no non-test caller |
| 21 | `POST /v1/artifacts/{artifact_id}/drafts` | `library.py:154` | A | — |
| 22 | `PUT /v1/artifacts/{artifact_id}/drafts/{draft_id}` | `library.py:170` | A | — |
| 23 | `POST /v1/artifacts/{artifact_id}/drafts/{draft_id}/seal` | `library.py:184` | A | — |
| 24 | `POST /v1/artifacts/{artifact_id}/versions/{version_id}/publish` | `library.py:199` | A | — |
| 25 | `POST /v1/artifacts/{artifact_id}/versions/{version_id}/withdraw` | `library.py:251` | A | — |
| 26 | `PUT /v1/organizations/{org}/projects/{project}/library/{artifact_id}` | `library.py:264` | A | — |
| 27 | `GET /v1/organizations/{org}/projects/{project}/library` | `library.py:283` | A | — |
| 28 | `DELETE /v1/organizations/{org}/projects/{project}/library/{artifact_id}` | `library.py:299` | A | — |
| B2 | `GET /v1/organizations/{org}/library` | `library.py:39` | **B** | `pages/Studies/StudyBuilder.tsx:46`; `components/Artifacts/ArtifactVersionPicker.tsx:24` (used by `Workbench/RunPanel.tsx`, `Jobs/LaunchSteps.tsx`) |
| B3 | `GET /v1/artifacts/{artifact_id}/versions` | `library.py:103` | **B** | `StudyDetail.tsx:161`; `ArtifactVersionPicker.tsx:29`; `StudyBuilder.tsx:89-90` |
| B4 | `GET /v1/artifacts/{artifact_id}/versions/{version_id}/content` | `library.py:122` | **B** | `StudyBuilder.tsx:92,95` |
| B5 | `POST /v1/artifacts/resolve` | `library.py:138` | **B** | `pages/Cases/CaseRevision.tsx:238` through `api/cases.ts:54` |

### 2.4 Project resources: router `/v1/organizations` (`organizations.py:97`)

| # | Operation (operation id) | Where | Class | Caller evidence |
|---|---|---|---|---|
| 29 | `POST …/projects/{project}/resources` (`createProjectResource`) | `organizations.py:1169` | A | — |
| 30 | `GET …/resources/{resource}/revisions/{revision}` (`getProjectResourceRevision`) | `organizations.py:1236` | A | — |
| 31 | `POST …/resources/{resource}/revisions` (`createProjectResourceRevision`) | `organizations.py:1278` | A | — |
| 32 | `GET …/resources/{resource}` (`getProjectResource`) | `organizations.py:1331` | A | — |
| 33 | `PATCH …/resources/{resource}` (`updateProjectResource`) | `organizations.py:1351` | A | — |
| 34 | `DELETE …/resources/{resource}` (`deleteProjectResource`) | `organizations.py:1375` | A | — |
| B6 | `GET …/projects/{project}/resources` (`listProjectResources`) | `organizations.py:1097` | **B** | `pages/Resources/resourceData.ts:7,31` (`loadPins`), used by `CollDetail.tsx:23` |
| B7 | `GET …/resources/{resource}/revisions` (`listProjectResourceRevisions`) | `organizations.py:1213` | **B** | `resourceData.ts:10` |

### 2.5 Composer

The composer had no endpoint of its own. It read the library (B2–B5) and saved case revisions through
`POST …/cases/{case}/revisions` (`organizations.py:993`), which the workbench still uses
(`openspec/changes/m24-retire-composer/design.md:38`). Nothing is added for it.

### 2.6 Sponsorship

| # | Operation (operation id) | Where | Class | Caller evidence |
|---|---|---|---|---|
| 35 | `POST /v1/admin/organizations/{organization_id}/sponsor` (`adminTransferOrganizationSponsor`) | `admin.py:707` | A | `api/client.ts:1302` `adminTransferSponsor` has no caller after slice 5 |
| 36 | `GET /v1/sponsor-proposals/{proposal_id}` (`getSponsorProposal`) | `sponsor_proposals.py:146` | A | no client function |
| B8 | `GET /v1/users/me/sponsor-proposals` (`listMySponsorProposals`) | `sponsor_proposals.py:97` | **B** | `pages/Account/SponsorRequestsForYou.tsx:88`; `components/NotificationDropdown/NotificationDropdown.tsx:52` |
| B9 | `GET /v1/organizations/{org}/sponsor-proposals` (`listOrganizationSponsorProposals`) | `sponsor_proposals.py:115` | **B** | `pages/Organization/OrgSettings.tsx:61` |
| B10 | `POST /v1/sponsor-proposals/{proposal_id}/accept` | `sponsor_proposals.py:163` | **B** | `SponsorRequestsForYou.tsx:39` |
| B11 | `POST /v1/sponsor-proposals/{proposal_id}/decline` | `sponsor_proposals.py:191` | **B** | `SponsorRequestsForYou.tsx:39` |
| B12 | `POST /v1/sponsor-proposals/{proposal_id}/cancel` | `sponsor_proposals.py:211` | **B** | `OrgSettings.tsx:174` |

Not expressible with a response header: the sponsor fields `billing_sponsor_user_id` and `replace_pending_proposal`
of `POST /v1/organizations` (`organizations.py:179`) and `PATCH /v1/organizations/{org}` (`organizations.py:237`).
These operations stay, and `OrgSettings.tsx:144` and `OrgCreate.tsx:150` use the fields. They leave with M4.3 (plans).

**Totals: 36 class-A operations, 12 class-B operations, 48 in all.** Other clients that still call class-A
operations: the developer tools `openbinding-gateway/tools/verify_analysis.py:35,75,80,107-114`, and a hint printed
by `tools/seed_dev.py:1449` (B6). QACOBench calls none of them: no match under `experimentation/qacobench/**/*.{py,yaml}`,
as ADR-0020 states.

## 3. Design sketch (S0 turns this into `design.md`)

- **One table, one middleware, no route file touched.** A new module `core/deprecation.py` holds the table of
  retired operations, keyed by `(method, path template)` with 36 rows under the recommended CRP-1 option. It also
  holds the two header values and a pure ASGI middleware. After routing, the middleware reads
  `scope["route"].path_format` in its wrapped `send` at `http.response.start`. If `(method, path_format)` is in the
  table, it adds both headers. It never buffers, so the streaming export (#4) is unaffected.
- **The OpenAPI document, in the same module.** `main.py:396` (`openapi_with_security_contract`) calls a function
  that sets `deprecated: true` on each table operation and declares `Deprecation` and `Sunset` on each of its
  responses. Both are declared as `components/headers`. `docs/openapi.json` is regenerated.
- **CORS.** `Deprecation` and `Sunset` join `CORS_EXPOSED_HEADERS` (`core/settings.py:46`), so browser clients can
  read them.
- **Wire values.** `Deprecation: @1792627200` (2026-10-22T00:00:00Z, the date the owner decided the retirements, ADR-0020
  line 5). `Sunset: <HTTP-date of CRP-2>`. RFC 9745 §2.1 defines the `@<epoch seconds>` form. RFC 8594 §3 defines
  `Sunset` as an HTTP-date. RFC 9745 §4 says the Sunset "MUST NOT be earlier than" the Deprecation. These were
  checked by lookup against rfc-editor.org.
- **Responses that carry the headers.** Every response to a request whose route matched a table row: 2xx, 3xx, and
  4xx from dependencies, `HTTPException`, validation or `BimError` handlers. **Responses that do not:** unmatched
  404s, 405s (the method is not in the table for that path), CORS preflights, 413s raised before routing, and 500s
  from the outermost unhandled-error handler (`main.py:345`).

Decisions (planner, routine and reversible):

- D1 `core/deprecation.py`, not `app/` or `shared/`. Reason: `tests/test_modules_skeleton.py:97-110` requires `app`,
  `shared` and `modules` to hold only `__init__.py`. `:125-127` forbids `main.py` from importing them. Moving the
  code there is M9.2 work.
- D2 Middleware plus a central table, not `deprecated=True` and a dependency per route. Reason: a dependency cannot
  add headers to responses that a route returns itself (`analysis.py:306,327`) or to error responses. The table also
  keeps `admin.py`, `organizations.py` and `sponsor_proposals.py` untouched. Those are R1 files
  (`.agentic/project.yaml:108`), and M4.3 C3 owns `sponsor_proposals.py` (`docs/agent-work/m4-plans-slices/handoff.md:59`).
- D3 `scope["route"]` is set by Starlette's `Router.app` before the endpoint runs. A lookup read this from Starlette's
  source on master with medium confidence; the lock pins starlette 1.3.1 (`uv.lock:2122`). The S1 tests pin the
  behaviour (2xx, 4xx, streaming, 405). If the key is absent in 1.3.1, the fallback is to match the request path
  against the compiled `path_regex` of the table's routes, in the same module.
- D4 The Deprecation date is a constant, 2026-10-22, not the merge day used by m43. Reason: a test can pin it, and the
  owner's decision date is the true deprecation date. RFC 9745 allows a past date.
- D5 No `Link` header in this step. Reason: no class-A operation has an API successor, and no public documentation
  URL exists yet. `rel="deprecation"` can be added later without a new requirement revision.
- D6 No feature flag. Reason: one capability, additive headers, and a revert is the rollback.

## 4. Slices

S0, S1 and S2 land as **one PR** for one capability, done as three sequential tasks. S1's red run is the G3 evidence
before S2 starts, and red tests are never merged alone. S3 runs after the merge. Nothing merges before the CRP-1 and
CRP-2 answers. With those answers, every slice below is mechanical.

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S0 | OpenSpec change: proposal, design (§3), tasks, `specs/gateway-api/spec.md` delta with the requirements of §5 and the CRP answers | specifier · default · ~25 | `openspec/changes/m24-deprecate-retired-endpoints/**` | this intake, `crp-draft.md`, `openspec/specs/gateway-api/spec.md`, ADR-0020, `openspec/changes/m43-plans-pricing-route/design.md:224-286` (precedent), `openspec/changes/m24-retire-screens/specs/frontend-workspace/spec.md:263-285` | ~150 lines of spec | low: no code | CRP-1, CRP-2 answered |
| S1 | Tests first: one table-driven test file, red on the base | implementer (tests only) · default · ~30 | `openbinding-gateway/tests/test_retired_operations_deprecation.py` | S0 change, `tests/conftest.py:287` (`api_client`), `tests/test_b2_cors.py`, `tests/test_openapi_contract.py`, `tests/test_binding_analysis.py`, `tests/test_artifact_library.py`, `tests/test_b3_sponsor_proposals.py` | ~200 test lines | low: test only | S0 |
| S2 | Implementation: table, middleware, OpenAPI annotation, CORS, snapshot, API note | implementer · default · ~40 | `openbinding-gateway/src/openbinding_gateway/core/deprecation.py` (new), `openbinding-gateway/src/openbinding_gateway/main.py`, `openbinding-gateway/src/openbinding_gateway/core/settings.py`, `openbinding-gateway/tests/test_deprecation_unit.py` (new: header formatting and the table's invariants), `docs/openapi.json` (generated), `docs/API_DEPRECATIONS.md` (new) | S0, S1 (frozen: S2 does not edit it) | ~170 lines plus the generated snapshot | **medium**: a compatible public API change (R3 `high_if_breaking`), and a middleware on every response | S1 red evidence |
| S3 | ROADMAP status: M2.4 endpoint step merged | doc-steward · low effort · ~10 | `ROADMAP.md` (Status cell `:20` and the dated paragraph `:75-79` only) | merged PR, this intake | ~5 lines | low | S2 merged |

The requirement ids are proposed for S0, which writes them in EARS form:

- `req~gateway-api-retired-operation-headers~1`: WHEN the gateway answers a request whose method and path template
  match a row of the retired-operations table, THE gateway SHALL add `Deprecation: @1792627200` and
  `Sunset: <CRP-2 date>` to the response, whatever its status. The Sunset is not earlier than the Deprecation.
- `req~gateway-api-retired-operation-set~1`: the table holds exactly the operations approved in CRP-1. No operation of
  class B and no other operation gets a `Sunset` from it.
- `req~gateway-api-retired-operation-openapi~1`: the OpenAPI document marks exactly the table operations
  `deprecated: true` (besides the operations that were already deprecated, today `getPricingDocument`) and declares
  both headers on each of their responses.
- `req~gateway-api-retired-operation-unchanged~1`: status codes, bodies, authentication and permissions of the table
  operations are unchanged. Evidence: their existing tests pass unedited.
- `req~gateway-api-deprecation-headers-exposed~1`: `Deprecation` and `Sunset` are among the CORS exposed headers.

S1 test outline. Every test carries `[utest->req~…~1]`, and expected values are literals from the spec, never imported
from `core/deprecation.py`, so S1 can run red before that module exists:

1. Parametrized over the 36 rows, with sample path params (valid UUIDs where the route parses UUIDs): an
   unauthenticated call answers 401 (or 404/422 as the route decides) and carries both exact headers.
2. One authenticated success per area: `GET /v1/analysis/sources` 200; `POST /v1/organizations/{org}/library` 201;
   `POST …/reports` 201; `POST …/resources` 201; `GET /v1/sponsor-proposals/{random uuid}` 404. Each carries the
   headers. Also the streaming `POST /v1/analysis/export` if the fixtures of `test_archive_analysis.py` allow it.
3. The 12 class-B operations, plus `GET /health`, `GET /v1/organizations` and `GET …/publications`: no `Sunset` and
   no `Deprecation`.
4. A wrong method on a retired path (405) and an unknown path (404): no headers.
5. OpenAPI: the set of `deprecated: true` operations equals the table plus the pre-existing set recorded in the test.
   Both headers are declared on every response of the table operations.
6. CORS: both names are in `CORS_EXPOSED_HEADERS` and in `access-control-expose-headers` for an allowed origin.
7. The parsed `Sunset` is later than or equal to the parsed `Deprecation`.

Guard tests 3 and 4 pass on the base by design. They sit in the same file as red tests 1, 2, 5, 6 and 7, and the
test-reviewer accepts them as negative controls (G3 note).

## 5. Checks (argv arrays; none is registered for this task, so the coordinator registers them per slice)

| # | Slice | cwd | argv | Expectation |
|---|---|---|---|---|
| 1 | S0 | `.` | `["openspec","validate","m24-deprecate-retired-endpoints","--strict"]` | exit 0. Needs openspec-cli, which is `todo: true` (`project.yaml:34`). Without it, S0 says the check was not run |
| 2 | S0–S3 | `.` | `["git","diff","--check"]` | exit 0 |
| 3 | S1 | `openbinding-gateway` | `["uv","run","--locked","--extra","test","pytest","--collect-only","-q","tests/test_retired_operations_deprecation.py"]` | exit 0: rules out red for the wrong reason (import errors) |
| 4 | S1 red, S2 green | `openbinding-gateway` | `["uv","run","--locked","--extra","test","pytest","-q","-p","no:cacheprovider","tests/test_retired_operations_deprecation.py"]` | S1: fails, naming the missing headers. S2: exit 0 |
| 5 | S2 | `openbinding-gateway` | `["uv","run","--locked","--extra","test","pytest"]` (registered G5 `gateway-unit`) | exit 0; the existing tests of the retired operations pass unedited |
| 6 | S2 | `openbinding-gateway` | `["uv","run","--locked","python","tools/dump_openapi.py","--check"]` (G7 `openapi-snapshot`) | exit 0 after regenerating with the same argv without `--check` |
| 7 | S2 | `openbinding-gateway` | `["uv","run","--locked","--extra","test","pytest","tests/test_openapi_contract.py","tests/test_b4_problem_schema.py","tests/test_bim_consumer_contract.py"]` (G7) | exit 0 |
| 8 | S1, S2 | `openbinding-gateway` | `["uv","run","--locked","--extra","test","ruff","check","src","tests"]` (G9) | exit 0 |
| 9 | S2 | `openbinding-gateway` | `["uv","run","--locked","--extra","test","--group","lint","lint-imports","--config",".importlinter"]` and the same with `importlinter-modules.ini` | exit 0 |
| 10 | S2, S3 | `.` | `["python3","tools/generate_changelog.py","--check"]` (G9 `changelog`) | exit 0 after the final `chore(changelog)` commit |

## 6. Gates per slice

| Gate | S0 | S1 | S2 | S3 |
|---|---|---|---|---|
| G1 spec | check 1 | — | — | n/a |
| G2 EPIC | spec-auditor ≥ 2/3 | — | — | n/a |
| G3 red-before | n/a | check 4 red, check 3 green | — | n/a |
| G4 acceptance frozen | trivially (`acceptance/**` untouched) | idem | idem; S1 file unedited | idem |
| G5 green-after | n/a | n/a | checks 4, 5 | n/a |
| G6 trace | tags planned | `[utest->…]` | `[impl->…]` in `core/deprecation.py` | n/a |
| G7 contracts | n/a | n/a | checks 6, 7; compatible change: `deprecated` flags and response headers only | n/a |
| G9 quality | check 2 | check 8 | checks 8, 9, 10 | checks 2, 10 |
| G11 review | reviewer | test-reviewer | medium panel `[reviewer, test-reviewer]` plus arch-reviewer (a middleware on every response, a new `core` module) | reviewer |
| G12 lab/UI | n/a | n/a | the preview answers with the headers (G13 example below); no UI change | n/a |
| G13 package | `how_to_review` | — | `how_to_test`: `curl -si -H "Authorization: Bearer <token>" "$PREVIEW/v1/analysis/sources"` shows `Deprecation: @1792627200` and `Sunset: …`; the same on `GET …/projects/{project}/resources` shows neither | n/a |

## 7. Risks

- A kept screen calling a deprecated operation. Mitigation: class B is excluded under the recommended option, and
  test 3 pins it.
- The Sunset could pass before any release carried the headers (R1 is not dated). Mitigation: M9.6 removes nothing
  unless a release with the headers has shipped **and** the Sunset has passed. A later Sunset is a compatible change;
  an earlier one is not (CRP-2).
- The `scope["route"]` assumption (D3) has a tested fallback.
- Cost: one dict lookup per response.
- Spec conflict: `req~frontend-retire-gateway-untouched~1` says that no response of `/v1/analysis/*` carries the
  headers (`openspec/changes/m24-retire-screens/specs/frontend-workspace/spec.md:263-280`). Its scope is the diffs of
  the screen slices, and no test asserts it (Grep: no `Deprecation` under `openbinding-gateway/tests`). S0 records
  that this change ends it, and it is reconciled when the m24 changes are archived.
- m43 (pricing) plans its own `Deprecation` and `Link` on `/v1/pricing*` (`m43-plans-pricing-route/design.md:276`).
  Whichever change lands second should use the same `core/deprecation.py` table (followup).
- Data: none changes. Report drafts, workspaces, sponsorship proposals and library drafts stay until M9.6 (CRP).

## 8. Open questions

- CRP-1 and CRP-2 (owner, `crp-draft.md`).
- For the coordinator: register checks 1–10 for the slices. Checks 3 and 4 are new.
