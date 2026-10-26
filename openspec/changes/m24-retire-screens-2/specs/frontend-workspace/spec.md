## ADDED Requirements

### Requirement: Report editor addresses redirect to the publications
WHEN a person opens an address that matches `/app/:org/:project/reports` or `/app/:org/:project/reports/:report` and no screen of the route registry matches, THE frontend SHALL replace the current history entry with `/app/<org>/<project>/publications`.

`req~frontend-retire-reports-redirect~1`

Needs: impl, utest

#### Scenario: The report list
- **GIVEN** a signed-in person on `/app/account`
- **WHEN** the person follows a link to `/app/isa-demo/qos-benchmarks/reports` and then goes back once
- **THEN** the address after the redirect is `/app/isa-demo/qos-benchmarks/publications`
- **AND** going back shows `/app/account`, not `/app/isa-demo/qos-benchmarks/reports`

#### Scenario: A report with a query and a hash
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/isa-demo/qos-benchmarks/reports/engine-comparison?edition=2&tab=source#blocks`
- **THEN** the address becomes `/app/isa-demo/qos-benchmarks/publications` with no query and no hash
- **AND** the level-1 heading is `Publications`, not the report title `Engine comparison at checkout`

#### Scenario: Slugs are encoded as path segments
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/isa%20demo/qos-benchmarks/reports/old%20notes`
- **THEN** the address becomes `/app/isa%20demo/qos-benchmarks/publications`

#### Scenario: Signed out first
- **GIVEN** no session
- **WHEN** the visitor opens `/app/isa-demo/qos-benchmarks/reports/engine-comparison` and signs in
- **THEN** the frontend shows `/login` first and then `/app/isa-demo/qos-benchmarks/publications`

#### Scenario: The target is a routed screen
- **GIVEN** the two slice-2 entries of `RETIRED_ROUTES`, the empty query and the params `org=a`, `project=b`, `report=c`
- **WHEN** each target is computed and matched against `routeDefinitions`
- **THEN** each target is `/app/a/b/publications` and resolves to `proj-publications`

#### Scenario: An artifact named reports keeps its screen
- **GIVEN** a signed-in person and the organization `isa-demo` whose library holds an artifact `reports`
- **WHEN** the person opens `/app/isa-demo/library/reports`
- **THEN** the address stays `/app/isa-demo/library/reports`
- **AND** the screen `lib-artifact` is rendered, not `proj-publications`

Evidence: `frontend/src/routes/retiredRoutes.test.tsx`; `frontend/src/routes/retiredRoutes.tsx`; `frontend/src/routes/index.tsx`

Both paths are entries of slice 2 (`slice: 2`) in `retiredRoutes.tsx` and share one rule. The `report` slug, every query
parameter and the hash are dropped; `<org>` and `<project>` are percent-encoded as one path segment. The redirect sits
behind the client-side guard, as for slice 1. The address of the artifact `reports` matches the pattern too and keeps
its screen (design.md §2).

### Requirement: Report editor screens are not routed
THE route registry SHALL declare neither the screen id `rep-list` nor `rep-detail`, nor the path `/app/:org/:project/reports` nor `/app/:org/:project/reports/:report`.

`req~frontend-retire-reports-screens-not-routed~1`

Needs: impl, utest

#### Scenario: Slice 2 ids are gone
- **GIVEN** the route registry after slice 2
- **WHEN** the registry test lists the ids of `routeDefinitions`
- **THEN** neither `rep-list` nor `rep-detail` is among them
- **AND** neither `analysis-sources` nor `analysis-workspace` is among them

#### Scenario: Slice 2 paths are gone
- **GIVEN** the route registry after slice 2
- **WHEN** the registry test lists the paths of `routeDefinitions`
- **THEN** neither `/app/:org/:project/reports` nor `/app/:org/:project/reports/:report` is among them
- **AND** the D6 list of the registry test reads `study-list`, `study-builder`, `study-detail`, `study-run`, `study-cell`, `study-analytics`, `proj-publications`, `verifier`

Evidence: `frontend/src/routes/routes.test.ts`; `frontend/src/routes/d6.tsx`

The pages of the two screens are deleted with their tests (design.md §1). The ids and paths of slice 1 stay absent
(requirement "Retired screens are not routed").

### Requirement: No link leads to a report editor address
IF a non-test source file under `frontend/src` other than `routes/retiredRoutes.tsx` holds a string or template literal that starts with a retired path with parameters of the redirect table, or, outside `src/api/`, one with `${…}` followed by the static tail of such a path, THEN the frontend test suite SHALL fail naming the file and the literal.

`req~frontend-retire-reports-no-link~1`

Needs: impl, utest

#### Scenario: Full addresses are reported
- **GIVEN** the retired paths `/app/:org/:project/reports` and `/app/:org/:project/reports/:report` and the synthetic source `pages/X.tsx` holding ``const a = `/app/${org}/${project}/reports`;`` and `const b = '/app/acme/demo/reports/x';`
- **WHEN** the link scan reads it
- **THEN** it returns exactly ``pages/X.tsx: /app/${org}/${project}/reports`` and `pages/X.tsx: /app/acme/demo/reports/x`

#### Scenario: Tails after an interpolation are reported
- **GIVEN** the same retired paths and the synthetic source `pages/Y.tsx` holding ``const a = `${root}/reports`;``, ``const b = `${root}/reports/${slug}`;`` and ``const c = `${root}/reports?draft=1`;``
- **WHEN** the link scan reads it
- **THEN** it returns exactly ``pages/Y.tsx: ${root}/reports``, ``pages/Y.tsx: ${root}/reports/${slug}`` and ``pages/Y.tsx: ${root}/reports?draft=1``

#### Scenario: Look-alikes and gateway paths are not reported
- **GIVEN** the same retired paths, the synthetic source `pages/Z.tsx` holding `'/app/acme/demo/reportsx'`, ``` `${root}/reportsx` ```, ``` `${root}/publications` ``` and `'/app/acme/demo/publications'`, and the synthetic source `src/api/platform.ts` holding ``` `${root(org, project)}/reports/${encodeURIComponent(report)}` ```
- **WHEN** the link scan reads them
- **THEN** it returns an empty list

#### Scenario: The application sources hold no report editor address
- **GIVEN** the application sources after slice 2
- **WHEN** the link scan reads them with the paths of `RETIRED_ROUTES`
- **THEN** it returns an empty list
- **AND** the public resolver's `Open in platform` link of a report located in `isa-demo/qos` is `/app/isa-demo/qos/publications`

Evidence: `frontend/src/routes/links.test.ts`; `frontend/src/pages/Resolve/Resolve.test.tsx`

Paths without parameters (slice 1) are scanned as before (requirement "No link leads to a retired address"). Each
parameter stands for one segment or one `${…}`; the match is followed by the end of the literal, `/`, `?`, `#` or `${`.
The static tail of the first path is `/reports` and that of the second is `/reports/:report`; the tail form is not
applied under `src/api/`, whose `/v1/…/reports` paths are gateway operations, while the full form applies to every
file. An address built from pieces (`` `${base}/${section}` `` with `section` `'reports'`) is a known limit; the
resolver's one is re-pointed and tested by its screen (design.md §3).

### Requirement: Project tabs and palette lead to the publications, not the reports
THE project tabs and the command palette SHALL offer no tab and no command whose address is `/app/<org>/<project>/reports`, alone or followed by `/`, `?` or `#`.

`req~frontend-retire-reports-navigation~1`

Needs: impl, utest

#### Scenario: Project tabs of a member
- **GIVEN** a member of `isa-demo` on `/app/isa-demo/qos-benchmarks/studies`
- **WHEN** the project tabs are rendered
- **THEN** their links read `Overview`, `Cases`, `Library`, `Jobs`, `Studies`, `Publications`, `Files`, `Package`, `Settings`
- **AND** the link `Publications` has the `href` `/app/isa-demo/qos-benchmarks/publications`
- **AND** no link of the tabs is named `Reports` or has an `href` that starts with `/app/isa-demo/qos-benchmarks/reports`

#### Scenario: Project tabs of a public visitor
- **GIVEN** a visitor reading the public project `qos-benchmarks` of `isa-demo` (access `public_read`), who sees the `Publications` tab as it saw `Reports`
- **WHEN** the project tabs are rendered
- **THEN** their links read `Overview`, `Cases`, `Library`, `Studies`, `Publications`, `Files`

#### Scenario: The publications screen marks its tab
- **GIVEN** a member on `/app/isa-demo/qos-benchmarks/publications`
- **WHEN** the screen is rendered
- **THEN** the tab `Publications` carries `aria-current="page"`

#### Scenario: Palette commands of a project
- **GIVEN** `buildCommands` with an organization `isa-demo`, the project `qos-benchmarks` selected and an administrator
- **WHEN** the commands are built
- **THEN** one command of the group `Project` is labelled `Publications` with the `href` `/app/isa-demo/qos-benchmarks/publications`
- **AND** no command is labelled `Reports`, and no command has an `href` that is `/app/isa-demo/qos-benchmarks/reports` or starts with `/app/isa-demo/qos-benchmarks/reports/`, `/app/isa-demo/qos-benchmarks/reports?` or `/app/isa-demo/qos-benchmarks/reports#`

Evidence: `frontend/src/components/PlatformShell/{SectionNav.test.tsx,paletteCommands.test.ts,ProjectTabs.tsx,paletteCommands.ts}`

The tab and the project command `Reports` become `Publications` at the same place (section `publications`, suffix
`/publications`; command at `<project>/publications`).

### Requirement: Report page offender leaves the allow-list
THE raw-rendering allow-list SHALL hold no entry for `pages/Reports/RepDetail.tsx`, with `MAX_ALLOWED_OFFENDERS` 13.

`req~frontend-retire-reports-allow-list~1`

Needs: impl, utest

#### Scenario: Slice 2 entries
- **GIVEN** the allow-list after slice 2
- **WHEN** the hygiene test reads it
- **THEN** the offender numbers of `RAW_RENDERING_ALLOW_LIST` read 1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15
- **AND** `MAX_ALLOWED_OFFENDERS` is 13 and `ceilingMismatch` returns nothing for it
- **AND** `UNLISTED_FINDINGS` holds only finding 16, `pages/Workbench/SourcePanel.tsx`
- **AND** no entry of either list names a file under `pages/Analysis/`, the file `pages/Reports/RepDetail.tsx` or the file `pages/Reports/SavedDecision.tsx`

#### Scenario: The sources still pass the three checks
- **GIVEN** the application sources after slice 2 and the allow-list after slice 2
- **WHEN** `unlistedFindings`, `staleEntries` and `wrongLineNumbers` read them
- **THEN** each returns an empty list

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`; `frontend/src/test/rawRenderingAllowList.ts`

Offender 5 (`pages/Reports/RepDetail.tsx`, the report document as JSON in `<pre>`) is deleted with its screen;
`pages/Reports/SavedDecision.tsx` is no detector finding and was never listed; offender 11 leaves with slice 3. The
ceiling rule of slice 1 (requirement "Allow-list ceiling equals its entries") keeps the ceiling equal to the entries.

### Requirement: Screen count after the report editor
THE route registry SHALL hold 78 screens, with 8 in domain D6.

`req~frontend-retire-reports-screen-count~1`

Needs: impl, utest

#### Scenario: Slice 2 count
- **GIVEN** the route registry after slice 2
- **WHEN** the registry test counts `routeDefinitions`
- **THEN** it counts 78 screens
- **AND** the domain sizes read D1 18, D2 7, D3 10, D4 18, D5 4, D6 8, D7 4 and D8 9

#### Scenario: A screen left behind
- **GIVEN** a registry that still declares `rep-detail` at `/app/:org/:project/reports/:report`
- **WHEN** the registry test runs
- **THEN** it fails, counting 79 screens instead of 78

Evidence: `frontend/src/routes/routes.test.ts`

82 before M2.4, 80 after slice 1, 78 after slice 2 (`rep-list` and `rep-detail`). The other domains keep their counts.
The redirect entries of `retiredRoutes.tsx` are not screens and are not counted.

### Requirement: Publications and verifier stay without report links
THE screens `proj-publications` at `/app/:org/:project/publications` and `verifier` at `/app/verifier` SHALL remain routed screens that render no link whose address starts with `/app/<org>/<project>/reports`.

`req~frontend-retire-reports-publications-stay~1`

Needs: impl, utest

#### Scenario: Both screens are routed
- **GIVEN** the route registry after slice 2
- **WHEN** `/app/isa-demo/qos-benchmarks/publications` and `/app/verifier` are matched against `routeDefinitions`
- **THEN** they resolve to `proj-publications` and `verifier`

#### Scenario: A publication without a report link
- **GIVEN** a member on `/app/isa-demo/qos-benchmarks/publications` and the published edition `engine-comparison` with the digest of its report
- **WHEN** the screen is rendered
- **THEN** the link `Open public verification` has the `href` `/resolve/report/<digest>`
- **AND** the publications list keeps its citation, copy, public link and withdraw controls
- **AND** no link is named `Open the report` or `Reports`, and no link has an `href` that contains `/reports`
- **AND** the breadcrumb reads `Home`, the organization, the project and `Publications`

#### Scenario: Nothing published yet
- **GIVEN** a member on `/app/isa-demo/qos-benchmarks/publications` of a project with no publication
- **WHEN** the screen is rendered
- **THEN** the empty state `Nothing published yet` is shown with no link named `Open the reports`
- **AND** the sentence `Publish a frozen report edition from its page.` is not shown

#### Scenario: A verifier match on a report
- **GIVEN** the verifier and a match of type `report` with the organization `isa-demo`, the project `qos-benchmarks` and the slug `engines-vs-seeds-informe`
- **WHEN** the match is rendered
- **THEN** its link `Open` has the `href` `/app/isa-demo/qos-benchmarks/publications`
- **AND** `entityHref` of a `report` entity in `isa-demo/qos-benchmarks` with the slug `engines report` returns `/app/isa-demo/qos-benchmarks/publications`

Evidence: `frontend/src/pages/Reports/{ProjPublications,Verifier}.test.tsx`; `frontend/src/pages/Platform/InspectionPages.test.tsx`; `frontend/src/routes/routes.test.ts`

The publications list loses `Open the report`, the `Reports` breadcrumb and action, and the `Open the reports` action
of its empty state. Per ADR-0020 "Existing publications keep their permanent links as read-only published results",
those links are `/resolve/report/<digest>`, which this slice does not touch.

### Requirement: No entry point into the report editor
THE job detail, the study run page, the study analytics page and the project overview SHALL offer no control that creates a report or opens a report or the report list.

`req~frontend-retire-reports-entry-points-removed~1`

Needs: impl, utest

#### Scenario: Job detail
- **GIVEN** a member on the job detail of the completed job `job-done-3` in `isa-demo/qos-benchmarks`
- **WHEN** the screen is rendered
- **THEN** no link or button is named `Add to a report`
- **AND** the frontend API client keeps its report operations (design.md §5)

#### Scenario: Study run and study analytics
- **GIVEN** a member on the run `run-1` of the study `engines-vs-seeds` in `isa-demo/qos-benchmarks`, and a project whose report `engines-vs-seeds-run-1` cites that run
- **WHEN** the study run page and then the study analytics page of that run are rendered
- **THEN** neither page shows a link or button named `Create a report` or `Open the report`
- **AND** neither page requests the project's reports and neither creates one

#### Scenario: Project overview
- **GIVEN** a member with the role MEMBER on `/app/isa-demo/qos-benchmarks` of a project with the frozen report `comparativa`
- **WHEN** the overview is rendered
- **THEN** no region is named `Reports` and no link is named `All reports`, `New report` or `Engine comparison`
- **AND** no link of the overview has an `href` that contains `/reports`

Evidence: `frontend/src/pages/{Jobs/JobDetail,Studies/StudyRun,Studies/StudyAnalytics,Project/ProjectOverview}.test.tsx`

The removed controls are `Add to a report` (job detail), `Create a report` and `Open the report` (study run and study
analytics, the "draft report from this run" feature of `pages/Studies/reportActions.ts`), and the `Reports` card with
`All reports` and the `New report` action (project overview).
