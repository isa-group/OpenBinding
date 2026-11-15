# 0036. The BIM language services live under `/v1/bim`

- Status: accepted
- Date: 2026-11-14 (F0b, decision D25 of the F0b implementation plan)

## Context

The Workbench needs a validator and starting points, and F0b removed the raw BIM API. Two validators existed
(`/v1/validate` and `/v1/instances/validate`), and `/v1/examples*` served the templates.

## Decision

The Workbench's backend is the problems API plus two stateless services: `POST /v1/bim/validate` (one validator; with
`?include=ir` it also returns the IR and its source map) and `GET /v1/bim/templates` with
`GET /v1/bim/templates/{template}`. Saving uses `createProblem` and `createProblemRevision`; opening a version uses
`getProblemRevisionSource`. One prefix keeps `application/problem+json`, opens the templates to anonymous callers and
groups the services that store nothing and belong to no organization. `/v1/bim/validate` is in the compile work class
for every caller; signed-in callers get the larger budget. Validation and save share `compile_package`, so a package
that validates is a package that saves.

## Consequences

- `tools/check_retired_surface.py` keeps bare `/v1/validate` and `/v1/examples` retired.
- "Templates" names what the Workbench uses them for, and leaves `validate` unambiguous next to F1's Composition API.

Where: `modules/problems/adapters/bim_routes.py`, `frontend/src/api/bim.ts`.
