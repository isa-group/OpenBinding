# Change: m24-retire-screens-2

## Why

ROADMAP M2.4: "Retirements, screens first (ADR-0020): decision-space workspace, report editor, library catalogue and
project resources, composer, sponsorship; old URLs redirect to their replacement; their endpoints answer with
`Deprecation` and `Sunset` headers (CRP)", accepted when "offenders 5, 7 and 11 gone with their screens; the route count
drops; no link leads to a retired screen". ADR-0020 decision 2: "Retire the decision-space workspace, the report editor,
the library as a catalogue, the composer and sponsorship", decided by the owner on 2026-10-22 (INTENT D8), and its
consequence: "Existing publications keep their permanent links as read-only published results, so nothing citable is
lost". ADR-0020 decision 5: "Screens go first, then endpoints".

Slice 1 (decision-space workspace) is specified in the change `m24-retire-screens`, merged and not archived. Its
requirements cannot be modified before it is archived, so slice 2 is specified in this change, with new requirement
ids `req~frontend-retire-reports-<name>~1`, on the same capability and the same redirect table.

## What Changes

Slice 2 retires the report editor:
- `/app/:org/:project/reports` (`rep-list`) and `/app/:org/:project/reports/:report` (`rep-detail`) are no longer
  screens; the registry drops from 80 to 78 screens, domain D6 from 10 to 8.
- Both old addresses open the project's publications, `/app/<org>/<project>/publications`, through the redirect table
  `frontend/src/routes/retiredRoutes.tsx`, whose rule now also reads the path parameters.
- The project tab `Reports` becomes `Publications`, and so does the project command of the palette.
- The ways into the editor go: `Add to a report` (job detail), `Create a report` and `Open the report` (study run and
  study analytics), the `Reports` card and the `New report` action (project overview), and the report links of the
  publications list. The verifier and the public resolver point a report at the project's publications.
- The raw-rendering allow-list loses offender 5 (`pages/Reports/RepDetail.tsx`); `MAX_ALLOWED_OFFENDERS` drops from 14
  to 13.

## Impact

- Capability: `frontend-workspace` (the route registry). Eight ADDED requirements, all `~1`:
  `frontend-retire-reports-redirect`, `frontend-retire-reports-screens-not-routed`, `frontend-retire-reports-no-link`,
  `frontend-retire-reports-navigation`, `frontend-retire-reports-allow-list`, `frontend-retire-reports-screen-count`,
  `frontend-retire-reports-publications-stay` and `frontend-retire-reports-entry-points-removed`. The requirements of
  `m24-retire-screens` are not modified here: the slice-1 values in some of their scenarios are superseded by slice 2,
  and the statement of `req~frontend-retire-redirect-generic~1` (target computed from the query) no longer covers the
  slice-2 rule; both are reconciled when the changes are archived (design.md §6, tasks.md follow-ups).
- Code: `frontend/src/routes/` (`d6.tsx`, `retiredRoutes.tsx`, `index.tsx`, `routes.test.ts`, `retiredRoutes.test.tsx`,
  `links.test.ts`), `frontend/src/pages/Reports/` (six pages deleted with their tests, the publications list edited),
  `frontend/src/pages/Studies/` (`reportActions.ts` deleted, `StudyRun.tsx`, `StudyAnalytics.tsx`),
  `frontend/src/pages/Jobs/JobDetail.tsx`, `frontend/src/pages/Project/ProjectOverview.tsx`,
  `frontend/src/pages/Platform/verifierOptions.ts`, `frontend/src/pages/Resolve/resolveModel.ts`,
  `frontend/src/components/PlatformShell/` (`ProjectTabs.tsx`, `paletteCommands.ts`), `frontend/src/test/` (allow-list
  and hygiene test), and the Playwright specs that open or expect the report editor (tasks.md S2).
- No HTTP API, OpenAPI, gateway, worker or database change: the `/v1/…/reports` operations keep answering as today,
  with no `Deprecation` or `Sunset` header, and the frontend API client keeps its report functions (removed with the
  endpoints in M9.6). The shared requirement `req~frontend-retire-gateway-untouched~1` applies to this slice's diff.
- Risks (design.md §7): an old report permalink lands on the publications list, not on the report; the publications of
  a project stay reachable, and every published edition keeps its permanent link `/resolve/report/<digest>`. Slice 2
  deletes far more lines than ~300; the lines it adds or changes stay near the guideline.
- G1 (`openspec validate m24-retire-screens-2 --strict`) is not run in the lab (no `openspec` binary); CI runs
  `openspec validate --strict --all`. The layout copies the merged change `m24-retire-screens`.

## Out of scope

- Any gateway endpoint, worker or queue change, and the `Deprecation` and `Sunset` headers of the report endpoints: they
  need an owner CRP (ROADMAP M2.4, M9.6).
- Exporting or dropping report drafts (ROADMAP M9.6), and the "Publish" of a study run or a collection version that
  ADR-0020 decision 2 introduces (a later milestone).
- Slices 3–5 (library catalogue and project resources, composer, sponsorship): specified when built (tasks.md).
- Editing `openspec/specs/**`, the change `m24-retire-screens`, ADR-0020, ROADMAP or INTENT; archiving this change.
