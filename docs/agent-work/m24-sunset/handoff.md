# Handoff: m24-sunset (M2.4 final step, `Deprecation` and `Sunset` on retired endpoints)
- Status: blocked (waiting on owner CRP-1 and CRP-2) · Updated: 2026-10-27
- Branch / head: planner task on base `00f653ef` · PR: none
- Owner request: own-f2201fb4bca74fb2ab472d3334323acf · ADR-0020 decision 5 · ROADMAP M2.4 (`ROADMAP.md:69`)

## Goal
The operations behind the five retired screens answer with `Deprecation` and `Sunset` for one minor release, while
their behaviour stays the same. Removal is M9.6 and is not part of this work.

## State (with evidence)
- Inventory done: 48 operations, of which 36 have no caller left (class A) and 12 are still called by kept screens
  (class B). Each row has `file:line` evidence in `intake.md` §2. Frontend callers were found by Grep over
  non-test sources at `00f653ef`.
- The composer has no endpoint of its own (`openspec/changes/m24-retire-composer/design.md:38`; it used B2–B5 and
  `organizations.py:993`, which stay).
- Owner CRP drafted: `crp-draft.md`. Request 1 is the scope (recommended: A, the 36). Request 2 is the Sunset date
  (recommended: Fri, 30 Apr 2027 23:59:59 GMT).
- Slices planned: `intake.md` §4 (S0 spec, S1 red tests, S2 code, S3 roadmap status), with checks in §5 and gates in
  §6.
- No check is registered for this task, and none was run.

## Decisions
- One table plus one ASGI middleware in `core/deprecation.py`; no route file edited. Reason: a per-route dependency
  cannot add headers to `JSONResponse`/`StreamingResponse` returns (`analysis.py:306,327`) or to error responses.
  The table also keeps the R1 files (`admin.py`, `organizations.py`, `sponsor_proposals.py`) and M4.3 C3's
  `sponsor_proposals.py` untouched (`.agentic/project.yaml:108`; `m4-plans-slices/handoff.md:59`).
- `core/`, not `app/` or `shared/`. Reason: `tests/test_modules_skeleton.py:97-110` requires those packages to hold
  only `__init__.py`, and `:125-127` forbids `main.py` from importing them.
- `Deprecation: @1792627200` (2026-10-22T00:00:00Z, the owner's decision date in ADR-0020). Reason: a fixed value a
  test can pin. RFC 9745 §2.1 allows a past date (checked by lookup against rfc-editor.org).
- No `Link` header and no feature flag. Reasons: there is no API successor and no public docs URL; the headers are
  additive, so a revert is the rollback.
- S0–S2 ship as one PR, as three sequential tasks. Reason: red tests never merge alone, and the capability is about
  170 changed lines.
- Publications `GET`/`DELETE` (`studies.py:1402,1416`) are out of scope. They are kept (`ProjPublications.tsx:66,81`)
  and belong to M6.5.

## Ruled out
- `deprecated=True` on each decorator, plus a header dependency: it misses error and direct responses, and it touches
  five route files, three of them R1.
- Putting the code in `app/` or `shared/`: it breaks `req~gateway-architecture-skeleton~1` tests (above).
- Gateway acceptance tests under `acceptance/api/`: no fixture there builds the app (`acceptance/api/conftest.py` only
  maps exit code 5). S1 uses the existing `api_client` fixture of `openbinding-gateway/tests/conftest.py:287`
  instead.
- Marking the 12 class-B operations now: kept screens call them (CRP option B or C, not recommended).

## Open questions and risks
- CRP-1 scope and CRP-2 Sunset date: waiting on the owner (the coordinator opens them from `crp-draft.md`).
- `scope["route"]` must be set by Starlette 1.3.1 before `http.response.start`. A lookup on Starlette master says yes,
  with medium confidence. S1 pins it for 2xx, 4xx, streaming and 405. The fallback is regex matching inside
  `core/deprecation.py`.
- `req~frontend-retire-gateway-untouched~1` (`openspec/changes/m24-retire-screens/specs/frontend-workspace/spec.md:263-280`)
  says that no `/v1/analysis/*` response carries the headers. No test asserts it. S0 records that this change ends it,
  and it is reconciled at the m24 archive.
- m43 pricing plans its own `Deprecation` on `/v1/pricing*` (`m43-plans-pricing-route/design.md:276`). Whichever
  change lands second should reuse the `core/deprecation.py` table.
- Sunset vs release: M9.6 must not remove anything until the Sunset has passed **and** a release carrying the headers
  has shipped.

## Next three steps
1. Coordinator: open `crp-ob-m24-sunset-scope` and `crp-ob-m24-sunset-date` from `crp-draft.md`, and register checks
   1–10 of `intake.md` §5.
2. After the answers: start S0 (specifier) with `intake.md` §3–§4 and the CRP quotes. If the scope answer is not A,
   rewrite the S1 row list from `intake.md` §2 (A rows, plus B rows for option B or C).
3. S1, then S2, then S3 as in `intake.md` §4. S1's check 4 must be red, and fail for the missing headers, before S2
   starts.

## Evidence
- Code read at `00f653ef`: `routes/analysis.py`, `routes/studies.py:1188-1416`, `routes/library.py`,
  `routes/organizations.py:1097-1375`, `routes/admin.py:707`, `routes/sponsor_proposals.py:97-211`,
  `main.py:345-392`, `core/settings.py:46-53`; frontend callers as cited in `intake.md` §2.
- Lookups: RFC 9745 and RFC 8594 header syntax and §4 ordering (high confidence, rfc-editor.org); Starlette
  `scope["route"]` (medium confidence, github.com/encode/starlette `routing.py` on master).
