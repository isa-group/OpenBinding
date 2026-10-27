# Tasks: m24-sunset

M2.4 endpoint step. S0 (this change), S1 and S2 ship as **one PR** into `develop`, as three sequential tasks. Red
tests never merge alone. S3 runs after the merge. The R1 step runs inside the R1 release PR. Tests carry
`[utest->req~gateway-api-…~1]` and code carries `[impl->…]` (design.md §4). Expected values in S1 are literals
copied from `specs/gateway-api/spec.md`, never imported from `core/deprecation.py`, so S1 can run red before that
module exists.

Checks to register (argv; `cwd` is the repository root unless noted), from `docs/agent-work/m24-sunset/intake.md` §5:
1. G1: `["openspec","validate","m24-sunset","--strict"]` (needs the openspec CLI in the lab; until then CI runs
   `openspec validate --strict --all`).
2. G9: `["git","diff","--check"]`.
3. S1 collect (`openbinding-gateway`):
   `["uv","run","--locked","--extra","test","pytest","--collect-only","-q","tests/test_retired_operations_deprecation.py"]`.
4. S1 red, S2 green (`openbinding-gateway`):
   `["uv","run","--locked","--extra","test","pytest","-q","-p","no:cacheprovider","tests/test_retired_operations_deprecation.py"]`.
5. G5 `gateway-unit` (`openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest"]`.
6. G7 `openapi-snapshot` (`openbinding-gateway`): `["uv","run","--locked","python","tools/dump_openapi.py","--check"]`.
7. G7 contracts (`openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest","tests/test_openapi_contract.py","tests/test_b4_problem_schema.py","tests/test_bim_consumer_contract.py"]`.
8. G9 ruff (`openbinding-gateway`): `["uv","run","--locked","--extra","test","ruff","check","src","tests"]`.
9. G9 import contracts (`openbinding-gateway`): `["uv","run","--locked","--extra","test","--group","lint","lint-imports","--config",".importlinter"]`
   and the same with `importlinter-modules.ini`.
10. G9 `changelog`: `["python3","tools/generate_changelog.py","--check"]`.

## S0. Specification (specifier)

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md` and `specs/gateway-api/spec.md` (14 ADDED requirements), with the
  CRP answers quoted (design.md §1).
- [ ] 0.2 G1 (check 1) green; G2 EPIC review by the spec-auditor.

## S1. Tests first (implementer, tests only), red on the base

Owned: `openbinding-gateway/tests/test_retired_operations_deprecation.py`. Read-only: this change,
`tests/conftest.py:287` (`api_client`), `tests/test_b2_cors.py`, `tests/test_openapi_contract.py`,
`tests/test_binding_analysis.py`, `tests/test_archive_analysis.py`, `tests/test_artifact_library.py`,
`tests/test_b3_sponsor_proposals.py`.

Module literals: `DEPRECATION = "@1792627200"`; `EXPECTED_SUNSET: str | None = None` (the only line the R1 release PR
changes in this file); `RETIRED` with the 36 `(method, path template)` rows of design.md §2.1; `KEPT_CALLED` with the
12 class-B rows of §2.2; `PREVIOUSLY_DEPRECATED = {"getPricingDocument"}`; `CLIENT_BINDINGS` with the bindings and
defining modules of §2.3. A helper `assert_deprecation_headers(response)` checks `Deprecation == DEPRECATION`, and
checks `Sunset` is absent when `EXPECTED_SUNSET is None`, otherwise equal to it.

- [ ] 1.1 `retired-operation-set`, `-deprecation`, `-no-sunset`: parametrized over the 36 `RETIRED` rows, an
  unauthenticated call with sample parameters (`isa-demo`, `p1`, slugs, random UUIDs where the route parses UUIDs).
  It accepts whatever status the route decides and calls `assert_deprecation_headers`. Red on the base.
- [ ] 1.2 `-deprecation`, `-unchanged`: one authenticated call per area, `GET /v1/analysis/sources` 200,
  `POST …/library` 201, `POST …/reports` 201, `POST …/resources` 201 and `GET /v1/sponsor-proposals/{uuid}` 404,
  plus `GET /v1/artifacts/not-a-uuid` 422. Each checks the status, then `assert_deprecation_headers`. Also the
  streaming `POST /v1/analysis/export` (`format` `csv`) with the fixtures of `test_archive_analysis.py`: 200, the
  headers, and the body equal to what that file expects. Red on the base.
- [ ] 1.3 `-set`, `-no-match` (guard): the 12 `KEPT_CALLED` rows, plus `GET /health`, `GET /v1/organizations`,
  `GET …/publications` and `DELETE …/publications/{publication}`: no `Deprecation` and no `Sunset`. It passes on the
  base by design (a negative control).
- [ ] 1.4 `-no-match` (guard): `PUT /v1/analysis/sources` and `DELETE /v1/artifacts/{uuid}` give 405,
  `GET /v1/analysis/does-not-exist` gives 404, and the CORS preflight `OPTIONS /v1/analysis/sources` from
  `http://localhost:5173`. None of them carries either header. Passes on the base.
- [ ] 1.5 `-openapi`, `-openapi-headers`: from the generated document, the set of `deprecated: true` operation ids
  equals the ids of `RETIRED` plus `PREVIOUSLY_DEPRECATED`. Every response of each `RETIRED` operation references
  `#/components/headers/Deprecation`. While `EXPECTED_SUNSET is None`, no response declares `Sunset` and
  `components/headers` has no `Sunset`; otherwise every such response references `#/components/headers/Sunset`. The
  `KEPT_CALLED` operations declare neither header. Red on the base.
- [ ] 1.6 `deprecation-headers-exposed`: `GET /v1/analysis/sources` with `Origin: http://localhost:5173` lists
  `Deprecation` and `Sunset`, and still the six current names, in `access-control-expose-headers`. Red on the base.
- [ ] 1.7 `-no-kept-caller` (guard): the scan of design.md §2.3 over `frontend/src`. It fails, and does not skip,
  when the directory is missing. On a finding it names the file and the binding. Passes on the base.
- [ ] 1.8 Checks 3 (green) and 4 (red, failing on missing headers, `deprecated` flags and exposed names, never on
  import or fixture errors), then check 8. The test-reviewer accepts 1.3, 1.4 and 1.7 as negative controls (G3 note).

## S2. Implementation (implementer)

Owned: `openbinding-gateway/src/openbinding_gateway/core/deprecation.py` (new),
`openbinding-gateway/src/openbinding_gateway/main.py`, `openbinding-gateway/src/openbinding_gateway/core/settings.py`,
`openbinding-gateway/tests/test_deprecation_unit.py` (new), `docs/openapi.json` (generated), `docs/API_DEPRECATIONS.md`
(new). The S1 file is frozen: S2 does not edit it.

- [ ] 2.1 `core/deprecation.py`: `DEPRECATION_VALUE = "@1792627200"`; `RETIRED_OPERATIONS_SUNSET: date | None = None`
  (D7); the 36-row table; `sunset_value()` (IMF-fixdate at 23:59:59 GMT, or `None`); a pure ASGI middleware that
  wraps `send` and adds the headers at `http.response.start` when `(scope["method"], scope["route"].path_format)` is
  a row (D3, with the regex fallback if S1 shows the key absent); `annotate_retired_operations(document)` (D9).
- [ ] 2.2 `main.py`: register the middleware (order per D3) and call the annotation from
  `openapi_with_security_contract` (`main.py:396`). No route file is edited.
- [ ] 2.3 `core/settings.py`: `Deprecation` and `Sunset` join `CORS_EXPOSED_HEADERS`, and the comment above it names
  them (D10).
- [ ] 2.4 `tests/test_deprecation_unit.py`: `-set` (36 unique rows, each a `(method, path_format)` of an app route,
  none of them a class-B row); `-sunset` and `-openapi-headers` with `RETIRED_OPERATIONS_SUNSET` patched to
  `date(2027, 4, 15)` (header `Thu, 15 Apr 2027 23:59:59 GMT` on a table row, none on
  `GET …/projects/p1/resources`; `Sunset` declared on every table response and as a component); `-sunset-floor`
  (`None` or ≥ `date(2027, 1, 20)`, a whole `date`, the failure naming 2027-01-20); `-docs` (each row's
  `METHOD path` in the page, `2026-10-22`, no class-B entry, the "not set yet" text while `None`).
- [ ] 2.5 Regenerate `docs/openapi.json` (`tools/dump_openapi.py`) and write `docs/API_DEPRECATIONS.md` (design.md §6).
- [ ] 2.6 Checks 4, 5, 6, 7, 8, 9 and 10. The existing tests of the retired operations pass unedited
  (`-unchanged`).
- [ ] 2.7 Review panel (G11): reviewer, test-reviewer and arch-reviewer (a middleware on every response, a new
  `core` module). G13: `curl -si "$PREVIEW/v1/analysis/sources"` shows `Deprecation: @1792627200` and no `Sunset`;
  `curl -si "$PREVIEW/v1/organizations/isa-demo/projects/p1/resources"` shows neither.

## S3. Roadmap status (doc-steward), after the merge

- [ ] 3.1 `ROADMAP.md`: the M2 Status cell (`:20`) and the dated M2.4 paragraph (`:75-79`) record the endpoint step
  merged, with `Deprecation` sent and `Sunset` to be set by the R1 release (never the `Status: PROPOSED` lines).
  Checks 2 and 10.

## R1. Inside the R1 release PR (release role; the owner merges)

- [ ] R.1 Set `RETIRED_OPERATIONS_SUNSET` to the R1 release date plus 90 days, where the release date is the date of
  the R1 entry in `CHANGELOG.md` (design.md §5).
- [ ] R.2 Regenerate `docs/openapi.json`; set `EXPECTED_SUNSET` in `tests/test_retired_operations_deprecation.py` to
  the header value; state the date in `docs/API_DEPRECATIONS.md`.
- [ ] R.3 The MRP shows the arithmetic. If the merge slips past the R1 entry date, move both dates before the owner
  merges (`req~gateway-api-retired-operation-sunset-by-release~1`). Checks 4, 5, 6 and 10 green on the release head.

## Archive (later)

- [ ] Archive in an explicit archive task after S2 is merged. Reconcile `req~frontend-retire-gateway-untouched~1`
  (change `m24-retire-screens`) at the same time (design.md §7). Then run
  `["openspec","archive","m24-sunset","--yes"]` and `["openspec","validate","--all","--strict"]`.

## Follow-ups outside this change

- M9.6 (owner CRP): remove the 36 operations, the dead client bindings of design.md §2.3, `tools/verify_analysis.py`,
  the `seed_dev.py` hint, the `analysis` queue and worker, and the data, once
  `req~gateway-api-retired-operation-removal-gate~1` holds.
- M3, M4.3 and M6.5: mark the class-B operations when their last kept screen moves off them (design.md §2.2).
- `m43-plans-pricing-route`: reuse `core/deprecation.py` for `/v1/pricing*`, and update `PREVIOUSLY_DEPRECATED`
  in whichever change lands second (design.md §7).
