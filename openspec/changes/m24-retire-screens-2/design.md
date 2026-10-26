# Design: m24-retire-screens-2

Status: slice 2 of M2.4 (report editor), specified, not built. Slice 1 and the rules every slice shares are in the
change `m24-retire-screens` (merged, not archived); this file describes slice 2 only. Fixed inputs: ROADMAP M2.4,
ADR-0020 decisions 2 and 5, INTENT D8, the route registry after slice 1 (80 screens, D6 with 10), the redirect table
`frontend/src/routes/retiredRoutes.tsx` of slice 1 and the allow-list after slice 1 (14 offenders, unlisted finding 16).

## 1. Context

Slice 2 retires two screens of domain D6, both declared in `frontend/src/routes/d6.tsx`:

| Id | Path | Page |
|---|---|---|
| `rep-list` | `/app/:org/:project/reports` | `frontend/src/pages/Reports/RepList.tsx` |
| `rep-detail` | `/app/:org/:project/reports/:report` | `frontend/src/pages/Reports/RepDetail.tsx` |

Only these two pages use `NewReport.tsx`, `PublishDialog.tsx`, `ReportBlocks.tsx` and `SavedDecision.tsx` (+
`SavedDecision.css`, moved there in slice 1): all six go with their tests (`RepList.test.tsx`, `RepDetail.test.tsx`,
`SavedDecision.test.tsx`). `pages/Studies/reportActions.ts` (`createRunReport`, `reportsOfRun`: the "draft report from
this run" feature of the study run and study analytics pages) goes too.

What stays in `pages/Reports/`: `ProjPublications.tsx` (`proj-publications`), `Verifier.tsx` (`verifier`), `parts.tsx`,
`Reports.css`, `reportErrors.ts` and `reportsModel.ts`. `reportsModel.ts` keeps only the exports still imported by a
non-test file (today ProjPublications uses `citationFields`, `citationText` and `citationBibtex`); `reportErrors.ts`
likewise (`reportRefusal` and its `ReportAction` values still used); `analysis/archive.ts` `decisionReceipt` (and its
test cases) goes only if `SavedDecision.tsx` was its last user. Their tests drop the cases of removed exports.

Unlike slice 1, the retired paths have parameters (`:org`, `:project`, `:report`), so the redirect has to read the path,
not only the query, and the link scan of slice 1 (prefix of a literal) does not see `` `${root}/reports` ``.

## 2. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Redirect target | `/app/<org>/<project>/publications` for both paths; `report`, the query and the hash dropped | the report's public verification `/resolve/report/<digest>`: the redirect would need the gateway to find the digest of a slug, drafts have none, and a redirect that loads data is no longer a table entry; the project overview: the publications list is where a frozen, published report still lives |
| Table shape | `RetiredRoute.target` becomes `(query: URLSearchParams, params: Readonly<Partial<Record<string, string>>>) => string`; entries get `slice: 2`; slice-1 entries ignore `params` | a second table for paths with parameters: two places to know retired addresses, against slice 1's "one table" |
| Reading the params | `RetiredRedirect` in `index.tsx` passes `useParams()` of the matched retired route; `org` and `project` are re-encoded with `encodeURIComponent` (React Router hands them decoded); an absent or empty `org` or `project`, which the router never produces for these paths, gives `/app` | passing the raw pathname: each rule would parse it again |
| Precedence | the retired routes are mounted after the screens in the protected application layout, so a screen wins a tie of rank. React Router ranks by segments and breaks an equal score by order among siblings; `/app/:org/:project/reports` (project `library`) ties with `lib-artifact` `/app/:org/library/:artifact` (artifact `reports`), which must keep `/app/<org>/library/reports`. The slice-1 paths are all static and still outrank `/app/:org` and `/app/:org/:project` | mounting before the screens, as in slice 1: the redirect would take over an artifact named `reports`; a reserved artifact slug: a data rule for a routing problem |
| Link scan | `retiredAddresses` reads each retired path with parameters in two forms (§4): the full path, each `:param` standing for one segment or one `${…}`, from the start of a literal; and the static tail (`/reports`, `/reports/:report`) directly after a `${…}`, not applied to files under `src/api/` | scanning for `/reports` anywhere: matches the gateway paths of `api/platform.ts`; only the full form: misses every link of the code, all written `` `${root}/reports…` `` |
| Project tab | `Reports` becomes `Publications` (key `publications`, suffix `/publications`) at the same place; `ProjectSection` swaps `'reports'` for `'publications'` and `ReportFrame` passes `active="publications"`. `utils/accessLevel.ts` needs no change: it names only the member-only sections (`jobs`, `package`, `settings`), so a visitor still sees the tab | dropping the tab: the publications list would only be reachable through Explore; keeping `Reports` pointing at `/publications`: the label would name a retired screen |
| Palette | the project command `Reports` becomes `Publications` at `<root>/publications` (description: published editions and how to cite them) | dropping it: as for the tab |
| Links | removed, except where a report match still names a project: the verifier and the public resolver point it at `<base>/publications` (§3) | removing the verifier's and resolver's links: a match that once opened a page would open nothing |
| Draft from a run | removed with `reportActions.ts`: the run and analytics pages no longer read the project's reports | keeping the create button: it would create a draft nobody can open or edit |
| Gateway and API client | untouched: no file under `openbinding-gateway/`, `engines/` or `docs/openapi.json` changes; `api/platform.ts` keeps `reports`, `createReport`, the update, delete, draft and freeze calls (removed with the endpoints, M9.6); `ProjPublications` and the project overview still read reports through it | removing the client functions now: ADR-0020 decision 5 retires code after the endpoints |

## 3. Links of slice 2

| Where | Link today | After slice 2 |
|---|---|---|
| `components/PlatformShell/ProjectTabs.tsx` | tab `Reports`, `<root>/reports` | tab `Publications`, `<root>/publications` |
| `components/PlatformShell/paletteCommands.ts` | Project › Reports, `<root>/reports` | Project › Publications, `<root>/publications` |
| `pages/Project/ProjectOverview.tsx` | `Reports` card (`All reports`, one link per report, `Verify`), action `New report` | card and action removed; the reports are still loaded for the sealed-history strip and the empty-project test |
| `pages/Jobs/JobDetail.tsx` | `Add to a report`, `<root>/reports` | removed |
| `pages/Studies/StudyRun.tsx` | `Create a report`, then `Open the report`, `<root>/reports/<slug>` | removed, with the reports request and the success notice |
| `pages/Studies/StudyAnalytics.tsx` | the same two controls | removed, as on the run page |
| `pages/Reports/ProjPublications.tsx` | `Open the report` per publication, breadcrumb `Reports`, action `Reports`, empty-state action `Open the reports` | removed; the breadcrumb ends `… › <project> › Publications`; `Open public verification` stays; the empty-state sentence "Publish a frozen report edition from its page." is reworded so it names no report page |
| `pages/Platform/verifierOptions.ts` | a `report` match: `<base>/reports/<slug>` | `<base>/publications` (the slug no longer matters) |
| `pages/Resolve/resolveModel.ts` | `Open in platform` of a `report` location: `<base>/reports/<slug>` | `<base>/publications`; built from the piece `'reports'`, which the link scan cannot see, so its own test pins it |

`components/PlatformShell/workspacePath.ts` keeps `reports` in `RESERVED_SLUGS` (an organization slug `reports` stays
unusable at `/app/reports`, as today).

## 4. Link scan

- Sources, exemptions and literal reading as in slice 1 (`m24-retire-screens` design.md §6). File keys are compared
  with and without a leading `src/`, so `src/api/x.ts` and `api/x.ts` are both under `src/api/`.
- For a retired path without parameters nothing changes. For one with parameters:
  - full form: the literal starts with the path, each `:param` matched by one segment without `/`, `?` or `#`, or by one
    `${…}`;
  - tail form (template literals, not under `src/api/`): the path's static tail, the part from the first static segment
    after a parameter (`/reports`, `/reports/:report`), directly follows the `}` of a `${…}`;
  - either form is a finding when followed by the end of the literal, `/`, `?`, `#` or `${`.
- So `` `/app/${org}/${project}/reports` ``, `'/app/acme/demo/reports/x'`, `` `${root}/reports` `` and
  `` `${root}/reports/${slug}` `` are findings; `'/app/acme/demo/reportsx'`, `` `${root}/publications` `` and
  `` `${root(org, project)}/reports/…` `` in `src/api/platform.ts` are not.
- Known limits: as in slice 1; also a tail kept in a plain string (`'/reports'` as a suffix in a table) is not seen,
  which is why the tab and the palette have their own requirement.

## 5. Allow-list

- Slice 2 removes the entry of offender 5 (`pages/Reports/RepDetail.tsx`, deleted) from `RAW_RENDERING_ALLOW_LIST`;
  `MAX_ALLOWED_OFFENDERS` becomes 13 and `ceilingMismatch` holds it equal to the entries. Offender numbers read 1–4, 6,
  8–15; unlisted finding 16 (`pages/Workbench/SourcePanel.tsx`) stays. The `retiredBy` values of the others are
  unchanged.
- Offender 11 (`pages/Library/ContentView.tsx`) leaves with slice 3.

## 6. Requirements, tests and the slice-1 scenarios

| Requirement | Tests |
|---|---|
| `frontend-retire-reports-redirect` | `routes/retiredRoutes.test.tsx` |
| `frontend-retire-reports-screens-not-routed` | `routes/routes.test.ts` |
| `frontend-retire-reports-no-link` | `routes/links.test.ts`; `pages/Resolve/Resolve.test.tsx` for the resolver |
| `frontend-retire-reports-navigation` | `components/PlatformShell/SectionNav.test.tsx`, `paletteCommands.test.ts` |
| `frontend-retire-reports-allow-list` | `test/rawRenderingHygiene.test.ts` |
| `frontend-retire-reports-screen-count` | `routes/routes.test.ts` |
| `frontend-retire-reports-publications-stay` | `pages/Reports/ProjPublications.test.tsx`, `Verifier.test.tsx`, `pages/Platform/InspectionPages.test.tsx` |
| `frontend-retire-reports-entry-points-removed` | `pages/Jobs/JobDetail.test.tsx`, `pages/Studies/StudyRun.test.tsx`, `StudyAnalytics.test.tsx`, `pages/Project/ProjectOverview.test.tsx` |

Tests carry `[utest->req~frontend-retire-reports-<name>~1]`; `retiredRoutes.tsx`, `index.tsx`, `d6.tsx`,
`ProjectTabs.tsx`, `paletteCommands.ts`, `verifierOptions.ts` and `rawRenderingAllowList.ts` carry `[impl->…]` for the
requirements they implement.

Several slice-1 scenarios state values that slice 2 changes: the D6 list (with `rep-list` and `rep-detail`), 80
screens and D6 10, offenders 1–6 and 8–15 with ceiling 14. The tests tagged with those slice-1 requirements move to
the slice-2 values and keep their `~1` tags; the slice-1 scenarios are reconciled when the changes are archived
(tasks.md, follow-ups). The statement of `req~frontend-retire-redirect-generic~1` no longer holds as written: it says
the target is computed "from the query", while slice 2 reads the path params, and slice 2 exempts
`/app/<org>/library/reports`, which matches a retired path; it is reconciled at the archive too (a new revision).

Slice-1 tests that iterate over every entry of `RETIRED_ROUTES` and expect decision-space targets
(`retiredRoutes.test.tsx`: the `it.each(RETIRED_ROUTES)` cases and the encoded-segments case) are limited to the
entries with `slice: 1`; the "every target is a routed screen" case passes sample params (`org=a`, `project=b`,
`report=c`) to every entry. `retiredScreens.test.tsx` moves from 80 screens and ceiling 14 to 78 and 13.

## 7. Risks

- An old report permalink (`/app/<org>/<project>/reports/<slug>`) lands on the project's publications list, not on the
  report. Accepted: the editor no longer exists, and ADR-0020's "Existing publications keep their permanent links as
  read-only published results" is served by the publications list and by `/resolve/report/<digest>`, which this slice
  does not touch. A draft that was never published is no longer visible in the frontend; its data stays in the gateway
  until M9.6 exports and drops it (CRP).
- The project overview loses its report list, including the `Verify` link of a published report; the publications
  list keeps `Open public verification` for each edition.
- A visitor without a session who opens an old report address signs in first and then lands on the publications; a
  project the person cannot read answers there as the publications screen does today.
- Slice 2 deletes six pages, one model file and their tests, far more than ~300 lines; the lines it adds or changes
  stay near the guideline (constitution 14.1). The deletions are mechanical and reviewed as such.
- The Playwright specs `s7b-reports.spec.ts`, `s6a-jobs.spec.ts`, `s7a-studies.spec.ts`, `s4b-project.spec.ts`,
  `qa-gallery.spec.ts` and `helpers/galleryRoutes.ts` open or expect the retired screens or links; they are updated in
  slice 2, and the gallery drops two screens.
- Moving the retired routes after the screens changes slice 1's mounting order; its tests (no organization page for
  `/app/analysis`, every redirect of slice 1) are run unchanged to show the ranking still sends the static paths to
  the redirect.

## 8. Rollback

Reverting the slice-2 PR restores both screens, their pages, the draft-from-run feature, the links, the `Reports` tab
and command, and offender 5 with ceiling 14. Nothing outside `frontend/` changes, and no data or API is touched.
