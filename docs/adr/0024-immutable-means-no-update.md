# 0024. Immutable rows reject UPDATE; history is kept by foreign keys

- Status: accepted
- Date: 2026-11-14 (F0b, decision D3 of the F0b implementation plan)

## Context

Problem revisions and their compilations are sealed: what a run executed must not change. Under the earlier
unconditional DELETE trigger, every problem (which always has revision 1) and every organization with a problem could
never be deleted, even when nothing had ever run on them.

## Decision

`binding_case_revisions` and `problem_compilations` reject UPDATE (`immutable(table, delete=False)`). A DELETE of a
revision or compilation that no run or study cell references is allowed. History is protected by foreign keys with
`ON DELETE RESTRICT`: `jobs.revision_id` and `jobs.compilation_id`, `study_cells.compilation_id`, and the
`retain_study_runs` / `retain_study_cells` triggers. `deleteProblem` and `deleteOrganization` check those references
first and answer `409` instead of letting PostgreSQL answer 500; a race that slips past the check is still caught by
the foreign key and mapped to the same 409.

## Consequences

- A problem nobody ran can be deleted; one with runs is kept as their evidence (`409 problem_has_runs`).
- There is no soft delete (`archived_at`) for problems: it would add state for no benefit.
- Pseudonymising an account no longer updates revisions, so the trigger needs no `created_by_id` exception.
- Every RESTRICT-dependent refusal has a PostgreSQL test (`openbinding-gateway/tests/concurrency/`), because
  the SQLite suite does not enforce foreign keys.

Where: `db/triggers.py`, `modules/problems/application/problems.py`, `routes/organizations.py`.
