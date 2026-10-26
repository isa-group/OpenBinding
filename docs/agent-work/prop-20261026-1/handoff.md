# Handoff: prop-20261026-1
- Status: in-progress (intake done, waiting on CRP-1/CRP-2 and the OpenSpec change) · Updated: 2026-10-26
- Branch / head: task/786fbb84c30f4acf / base 212b9662 · PR: none

## Goal
Stop `/v1/resolve` and `/v1/verifier` from returning made-up DOIs, venues, years, authors and dead URLs in
`citation`, without changing the response schema (INTENT O4, journey 1, principle 9).

## State (with evidence)
- Planned: three slices (`intake.md` section 4). S1: shared builder `services/citations.py` + `routes/resolve.py`
  (11 call sites). S2: `routes/verifier.py` (2 call sites). S3: `docs/RESOLVER_AND_VERIFIER.md`. Medium, medium, low.
- Verified at 212b9662:
  - made-up DOI, venue and year at `routes/resolve.py:177-180` and `routes/verifier.py:58-61`;
  - dead fallback `/verifier?digest=` (`resolve.py:184`, `verifier.py:61`). The live route is `/app/verifier`
    (`frontend/src/routes/d6.tsx:28`);
  - retired `/reports/` target (`verifier.py:74-75`, `retiredRoutes.tsx:46-47`).
- Found beyond the proposal:
  - made-up author "OpenBinding Research Group" (`resolve.py:176`, `verifier.py:57`);
  - a citation even for unregistered digests (`verifier.py:414-415,454-455`);
  - `PUBLIC_BASE_URL` is the gateway origin, not the frontend's (`core/settings.py:332-343`, `routes/cas.py:64`,
    `docker-compose.yml:170,178`);
  - a made-up Zenodo DOI in the normative doc (`docs/RESOLVER_AND_VERIFIER.md:132-135`).
- No code written, no checks run (none registered for this intake).

## Decisions
- D1: three slices, no feature flag. Reason: each slice only removes made-up values from one endpoint family, the
  schema is unchanged, and each is ≤ ~230 src lines (project limit 300, `.agentic/project.yaml:14`).
- D2: the shared builder lives in `services/`, not `routes/`. Reason: the layering test forbids services importing
  routes and points shared code to services (`tests/test_architecture_layers.py:415-427`).
- D3: DOI and venue only from the recorded `ArtifactPublication.citation` / `Publication.citation` of the exact
  version, and the DOI only when well-formed. Reason: these are the only recorded citations
  (`db/artifact_models.py:85`, `db/platform_models.py:577`), and they are free-form dicts (`models/platform.py:450`).
- D4: the model's `year: int = 2026` default stays. Reason: changing it changes `docs/openapi.json`, which is out of
  scope (no schema change). The builder always sets `year` explicitly.
- D5: URL tests reuse `assert_is_a_frontend_screen` from `tests/test_b2_resolve_urls.py:96-100` and do not change
  that file. Reason: one source of truth for the route table, and no shared file between slices.

## Ruled out
- Removing `citation` or making `year` optional: a schema change that needs the owner and a CRP (proposal
  alternatives).
- Using `PUBLIC_BASE_URL` for frontend links as the proposal says: in dev it points at the gateway (`:8000`), not the
  frontend (`:5173`), per `docker-compose.yml:170,178`. This is put to the owner in CRP-1, with `FRONTEND_URL`
  recommended.
- An acceptance-test slice: `acceptance/api/` has no app harness (`acceptance/api/conftest.py`). G3 is met with
  gateway tests written first.

## Open questions and risks
- CRP-1 (link target/origin; recommended `FRONTEND_URL` + `/resolve/<kind>/<digest>`). Waiting on the owner.
- CRP-2 (`citation: null` with no visible match; `authors: []` when unknown). Waiting on the owner.
- Q1 (security-auditor on S1/S2 for publisher-written citation JSON) and Q2 (acceptance tests): waiting on the
  coordinator.
- Risk: S2 breaks `req~resolver-verifier-inspect-indistinguishable~1`, for example if the year of a hidden entity
  leaks. Mitigation: hidden and unknown digests both have no visible entity and get the same citation;
  `tests/test_b1_verifier.py` must stay green.
- Risk: API clients relied on a non-null `doi`. Mitigation: the schema already allows null (`models/platform.py:562`);
  the PR body states the value change.

## Next three steps
1. Coordinator: open CRP-1 and CRP-2 from `intake.md` section 7, and have the specifier write the
   `resolver-verifier` delta with the three proposed requirement ids.
2. Register checks 0-6 of `intake.md` section 4 for S1 and start S1 (implementer, tests first, red-before check 1).
3. After S1 merges, start S2. S3 can start as soon as the CRPs are answered.

## Evidence
- Tasks: this intake (planner; no checks registered or run). Heads: 212b9662 · CI: none for this intake.
