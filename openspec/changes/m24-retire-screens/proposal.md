# Change: m24-retire-screens

## Why

ROADMAP M2.4: "Retirements, screens first (ADR-0020): decision-space workspace, report editor, library catalogue and
project resources, composer, sponsorship; old URLs redirect to their replacement; their endpoints answer with
`Deprecation` and `Sunset` headers (CRP)", accepted when "offenders 5, 7 and 11 gone with their screens; the route count
drops; no link leads to a retired screen". ADR-0020 decision 2: "Retire the decision-space workspace, the report editor,
the library as a catalogue, the composer and sponsorship", decided by the owner on 2026-10-22 (INTENT D8). ADR-0020
decision 5 orders the work: "Screens go first, then endpoints, after one minor release with `Deprecation` and `Sunset`
headers (CRP). Code goes next. Data goes last". INTENT principle 12 and O12 set a budget of at most 45 routed screens;
the registry holds 82 today.

## What Changes

State: specified; no slice is built. This PR specifies the whole series and delivers the requirements of slice 1 plus
the rules every slice shares (tasks.md).

M2.4 retires its screens in five sequential PRs, one screen group each, in this order:
1. decision-space workspace (`analysis-sources` at `/app/analysis`, `analysis-workspace` at `/app/analysis/workspace`);
2. report editor;
3. library catalogue and project resources;
4. composer;
5. sponsorship.

What slice 1 changes for people:
- `/app/analysis` and `/app/analysis/workspace` are no longer screens; the registry drops from 82 to 80 screens.
- An old address of a retired screen opens its replacement instead, through one redirect table
  `frontend/src/routes/retiredRoutes.tsx` that later slices extend. For slice 1: the study run page when the query names
  an organization, project, study and run; the study page when it names an organization, project and study; the job
  history `/app/jobs` otherwise. Every other query parameter is dropped.
- The main navigation loses its Analysis entry and the command palette its Analysis command.
- No link in the application leads to a retired address: the Analyze, Open analysis, Weigh trade-offs and Reopen
  decision space links of the job detail, job list, job history, binding analysis card, study analytics and report
  page are removed (design.md §3).
- The raw-rendering allow-list loses offender 7 (`pages/Analysis/Inspector.tsx`) and unlisted finding 17
  (`pages/Analysis/SavedDecision.tsx`); `MAX_ALLOWED_OFFENDERS` drops from 15 to 14, and the hygiene test fails when it differs from the number of entries.

## Impact

- Capability: `frontend-workspace` (the route registry). Ten ADDED requirements, all `~1`:
  `frontend-retire-screens-not-routed`, `frontend-retire-redirect-generic`, `frontend-retire-redirect-decision-space`,
  `frontend-retire-no-link-to-retired`, `frontend-retire-navigation`, `frontend-retire-palette`,
  `frontend-retire-allow-list-leaves`, `frontend-retire-allow-list-ceiling`, `frontend-retire-screen-count` and
  `frontend-retire-gateway-untouched`. The living requirement `req~frontend-workspace-route-registry~1` stays true and
  is not modified. Slices 2–5 add their own requirements (or extend the scenarios) in this change, one PR each.
- The allow-list rules are those of `req~frontend-rendering-raw-hygiene~1` in the unarchived change
  `m21-rendering-catalogue`, whose scenario "Today's offenders are listed" (15, exactly 1–15) no longer holds after
  slice 1; the allow-list requirements are placed here because this change removes the entries (design.md §5).
- Code of slice 1: `frontend/src/routes/` (`d6.tsx`, new `retiredRoutes.tsx`, `index.tsx`, `routes.test.ts`,
  `links.test.ts`), `frontend/src/pages/Analysis/` (deleted), `frontend/src/components/PlatformShell/`
  (`appNavigation.ts`, `paletteCommands.ts` and their tests), the pages and component that link to the workspace, the
  report page's saved-decision view (design.md §4), `frontend/src/test/rawRenderingAllowList.ts` and
  `rawRenderingHygiene.test.ts`, and the Playwright specs and gallery routes that open the retired screens.
- No HTTP API, OpenAPI, gateway, worker or database change: the `/v1/analysis/*` endpoints keep answering as today.
- Risks: a bookmark with a query the table does not read lands on the job history, not on the exact view it showed; an
  organization whose slug is `analysis` stays unreachable at `/app/analysis` (it already was); slice 1 deletes far more
  lines than ~300 (the whole `pages/Analysis/` folder), while the lines it adds or changes stay near the guideline
  (design.md §8).
- G1 (`openspec validate m24-retire-screens --strict`) is not run in the lab (no `openspec` binary); CI runs
  `openspec validate --strict --all`. The format was checked by reading against `openspec/changes/m21-rendering-catalogue/`
  and `openspec/changes/validate-public-origin-format/`.

## Out of scope

- Any gateway endpoint, worker or queue change, and the `Deprecation` and `Sunset` headers of the retired endpoints:
  they need an owner CRP (ROADMAP M2.4, M9.6).
- Removing frontend code that no retired screen needs any longer beyond the pages themselves (the API client,
  `frontend/src/analysis/`): code retirement follows the endpoints (ADR-0020 decision 5).
- The trade-off set on the run and study pages (ADR-0020 decision 3): a later milestone.
- The navigation and project tabs of ARCHITECTURE §5.2 and the 45-screen budget (M2.6).
- Editing `openspec/specs/**`, ADR-0020, ROADMAP or INTENT; archiving this change (separate archive task).
