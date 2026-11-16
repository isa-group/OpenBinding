# 0037. Anonymous validation at `/workbench` stays

- Status: accepted
- Date: 2026-11-14 (F0b, decision D26 of the F0b implementation plan)

## Context

`pub-workbench` is the only way to check a BIM package without an account; Home's "Validate a package" and the footer
link point at it.

## Decision

The anonymous Workbench at `/workbench` stays, on the same `POST /v1/bim/validate` the editor uses, under the
compile-class budget for anonymous callers. It stores nothing and reads no entity, so it does not reopen public read
(ADR 0034). Its "carry into a project" hand-off became "open in the Workbench of an organization" (OrganizationPicker).

## Consequences

- It costs one screen; dropping it would leave BIM with no public entry point.

Where: `frontend/src/routes/areas/public.tsx`, `frontend/src/components/ui/OrganizationPicker.tsx`.

Later: F2b draws a valid package from the gateway's facts with the shared workflow graph and candidate matrix,
shows a refused one's findings placed in its files and no structure, and opens the problem editor of an organization
for a signed-in visitor ([ADR 0051](0051-problem-editor-on-the-shared-core.md)).
