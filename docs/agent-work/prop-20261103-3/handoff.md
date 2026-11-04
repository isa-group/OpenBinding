# Handoff: prop-20261103-3
- Status: waiting-review (plan for the coordinator; CRP-1 and CRP-2 for the owner) · Updated: 2026-11-03T12:00:00Z
- Branch / head: task branch `task/ff408628ced74b9e` on `b8067258` · PR: none (planning only)

## Goal
Plan P-20261103-3 (O8 Security, owner-approved): the gateway refuses organization and project slugs that the
frontend's fixed `/app/` routes shadow, after PR 77 merges the final M2.6 route table. Facts F1-F23, slices, gates
and open questions are in [intake.md](intake.md).

## State (with evidence)
- Nothing is built. `models/platform.py:21,25-27,111-113` still checks only the `SLUG` pattern.
- The proposal's evidence is confirmed, and three gaps were found:
  - `analysis` is a reserved organization segment (retired redirect, `retiredRoutes.tsx:86-87`), and `library` a
    reserved project segment (`retiredRoutes.tsx:82-85`; `retiredScreens.test.tsx:201`).
  - `engines`, `language`, `organizations` and `system` shadow some project addresses (F4, F6).
  - UUID-shaped slugs are unreachable, because `organization_by_ref` and `project_by_ref` parse them as ids
    (`collaboration.py:36-41,141-149`).
- Design trap: `ProjectView` inherits `ProjectCreate` (`platform.py:126`, built for every stored row at
  `organizations.py:773`). An inherited validator would break reads of stored projects.
- PR 77's content and state were not verified (no repo tool for this role).
- No check was run: none is registered for this task, and its output is two documents.

## Decisions (planner; the coordinator may override)
- Two serial slices. S1 holds the list module, the gateway-side parity test and the read-only report (medium). S2
  enforces on create, documents the code and regenerates OpenAPI (high). Reason: the report must run before the
  refusal ships (CRP-2), and S1 changes no behaviour.
- No feature flag. Reason: one behavioural slice, and a revert rolls it back.
- The reserved list = static first segments under `/app/` (live and redirect tables) plus planned `runs`. The
  project list = static segments directly under `/app/:org/`. Entries are never removed. Reason: F4-F7, F21, Q4.
- The parity test is in the gateway (Q3). Reason: precedent `tests/test_b2_resolve_urls.py:40-73`, and any frontend
  change runs the gateway CI area (`tools/ci_changes.py:43-47`).
- Error shape recommendation: a model validator, so 422 `validation_error` with diagnostic `reserved_slug` (Q1 A).
  Reason: it keeps the change out of R1 `routes/organizations.py` (`.agentic/project.yaml:108`) and matches how the
  pattern failure is reported (`docs/ERRORS.md:36,49,98`).

## Ruled out
- A DB constraint or migration: it fails on colliding rows and is R6 (high).
- Querying production from an agent: forbidden (`.agentic/project.yaml:176`). The owner runs the report.
- A validator on `ProjectCreate` that `ProjectView` inherits: it would break listing stored projects (F10).
- A frontend vitest that reads the Python list: cross-package and fragile (Q3).
- Editing the create forms now: M2.6 CD rewrites them as dialogs (`m26-navigation/handoff.md:77`).

## Open questions and risks
- CRP-1 (owner): does the 422 count as breaking under §11.1 (planner: yes), with A (ship as a security fix), B
  (expand/contract) or C (form warning only)? Also 1b: refuse UUID-shaped slugs too?
- CRP-2 (owner): existing colliding rows. The owner runs the report on production. Recommended: grandfather the rows
  and notify their owners.
- Q1-Q5 (coordinator): error shape, OpenAPI `not: enum`, parity test location, reserving `runs` now, the coupling
  of M2.6 slices to the gateway list.
- Risk: after S1, an M2.6 slice adding a static `/app/` segment fails the gateway parity test (Q5). Mitigation:
  reserve the planned segments now, and give the slice `models/slugs.py` or run a one-line follow-up.
- Risk: PR 77 may change the route file layout (A1 plans `routes/areas/<area>.tsx`). S1's parser must read whatever
  layout PR 77 leaves. That is why S1 starts after the merge.

## Next three steps
1. Coordinator: send CRP-1 and CRP-2 (intake §7) to the owner as one decision request. Have a specifier write the
   OpenSpec change `reserved-slugs` (capability `collaboration-artifacts`, ids in intake §4) while PR 77 is open.
2. When PR 77 is merged and the change passes G1/G2, start S1 with the owned files and checks of intake §4. Hand the
   owner the report tool to run on production and the lab.
3. When CRP-1 is answered (and CRP-2, if the report finds rows), have test-designer freeze
   `acceptance/api/test_reserved_slugs.py`, then start S2.

## Evidence
- Planning task on `b8067258`. Facts with file:line are in intake.md §2. No lookups were needed.
- Checks: none registered for this task; none run.
