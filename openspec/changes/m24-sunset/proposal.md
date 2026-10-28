# Change: m24-sunset

## Why

ROADMAP M2.4 (`ROADMAP.md:69`): the retired screens' "endpoints answer with `Deprecation` and `Sunset` headers (CRP)".
ADR-0020 decision 5 (`docs/adr/0020-smaller-platform.md:45-46`): "Screens go first, then endpoints, after one minor
release with `Deprecation` and `Sunset` headers (CRP). Code goes next." INTENT objective O12 (Surface; principle 12,
journeys decide what exists). Owner request own-f2201fb4bca74fb2ab472d3334323acf.

The five screen slices are merged (PR #51, #53, #55, #65, #66). This change is the endpoint step: it only announces
the removal. Removing the operations is M9.6 (`ROADMAP.md:190`), behind its own CRP.

The owner answered both CRPs of `docs/agent-work/m24-sunset/crp-draft.md` (quoted in design.md §1):
- scope, option A: the headers go only on the **36 class-A operations** that no screen calls any more. The 12
  class-B operations stay unmarked, and a test pins that no kept screen calls a marked operation;
- Sunset date, option D: **no fixed Sunset date in the code now**. The R1 release PR, which only the owner merges,
  records "R1 date + 90 days". Until then the 36 operations send `Deprecation: @1792627200` alone.

## What Changes

- The 36 retired operations answer with `Deprecation: @1792627200` (2026-10-22T00:00:00Z, the owner's retirement
  decision), on every response whose route matched, success or refusal alike. No `Sunset` header is sent yet.
- One constant records the Sunset date. It is empty in this change, and the R1 release PR sets it to the R1 release
  date plus 90 days. From then on the same responses also carry `Sunset: <date> 23:59:59 GMT`.
- `docs/openapi.json` marks the 36 operations `deprecated: true` and declares the headers they send on each response.
- Browsers can read `Deprecation` and `Sunset`, because both join the CORS exposed headers.
- A new page, `docs/API_DEPRECATIONS.md`, lists the 36 operations, the Deprecation date, the Sunset status and what
  replaces each area.
- Status codes, bodies, authentication, API-key permissions and data do not change for any operation.

## Impact

- Capability `gateway-api`: 14 ADDED requirements, all `~1` (`specs/gateway-api/spec.md`). The
  `req~gateway-api-retired-operation-no-kept-caller~1` requirement scans frontend sources, but its test runs in the
  gateway suite, beside the table it guards (design.md D8). No `frontend-workspace` requirement is added.
- Code (S2): `openbinding-gateway/src/openbinding_gateway/core/deprecation.py` (new: the table, the Sunset constant,
  the ASGI middleware, the OpenAPI annotation), `main.py` (registers the middleware, calls the annotation),
  `core/settings.py` (`CORS_EXPOSED_HEADERS`), `docs/openapi.json` (regenerated), `docs/API_DEPRECATIONS.md` (new).
  No route file is edited (design.md D2).
- Tests: `openbinding-gateway/tests/test_retired_operations_deprecation.py` (S1, red first) and
  `openbinding-gateway/tests/test_deprecation_unit.py` (S2).
- Public API: a compatible change. It adds `deprecated` flags and response headers, and removes or changes nothing.
  The R1 release PR adds the `Sunset` header later, which is also compatible.
- Release process: the R1 release PR carries one code constant, a regenerated snapshot, one test literal and the docs
  page date (design.md §5). The owner accepted this cost by choosing option D.
- Earlier spec: this change ends the "no `Deprecation` or `Sunset`" clause of `req~frontend-retire-gateway-untouched~1`
  (change `m24-retire-screens`, scoped to the screen slices' diffs). It is reconciled at the m24 archive
  (design.md §7).
- Risks: design.md §8.
- Change id: the intake proposed `m24-deprecate-retired-endpoints`. This change uses the task's id, `m24-sunset`.

## Out of scope

- Removing any operation, its code, the `analysis` queue and worker, the dead frontend client functions, or data
  (M9.6, owner CRP).
- The 12 class-B operations (design.md §2.2). The change that moves their last screen off them marks them: M3 for the
  library and resource reads, M6.5 for the report list, M4.3 for the organization sponsor proposals.
- `GET` and `DELETE` of project publications (`studies.py:1402,1416`): they stay (M6.5).
- The sponsor fields of `POST /v1/organizations` and `PATCH /v1/organizations/{org}`. A response header cannot
  express them (M4.3).
- A `Link` header, a feature flag, and the `/v1/pricing*` deprecation of change `m43-plans-pricing-route`
  (design.md D5, D6, §7).
- Editing `openspec/specs/**`, earlier changes, ADR-0020, INTENT or ROADMAP; archiving.
