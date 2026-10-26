## ADDED Requirements

### Requirement: Library and resource addresses redirect
WHEN a person opens an address that matches `/app/:org/library`, `/app/:org/library/:artifact`, `/app/:org/library/:artifact/drafts/:draft`, `/app/:org/library/:artifact/versions/:version`, `/app/:org/:project/library`, `/app/:org/:project/resources` or `/app/:org/:project/resources/:resource` and that no screen of the route registry matches, THE frontend SHALL replace the current history entry with `/app/<org>` for the four library paths and with `/app/<org>/<project>/collections` for the three project paths, where `<org>` and `<project>` are the slugs of the opened address each percent-encoded as one path segment, with no query and no hash.

`req~frontend-retire-library-redirect~1`

Needs: impl, utest

Evidence: `frontend/src/routes/retiredRoutes.test.tsx`; `frontend/src/routes/retiredRoutes.tsx`; `frontend/src/routes/index.tsx`

The seven paths are entries of slice 3 (`slice: 3`) in `frontend/src/routes/retiredRoutes.tsx`: the four library
entries come first in `RETIRED_ROUTES`, then slices 1 and 2, then the three project entries. The redirect sits behind
the client-side guard and keeps `state.from`, as for slices 1 and 2. The retired routes stay mounted after the screens,
so a screen wins a tie of rank and, among retired routes, the earlier entry wins (design.md §2):
`/app/<org>/library/reports`, `/app/<org>/library/library` and `/app/<org>/library/resources` open `/app/<org>`, and
`/app/<org>/library/collections` stays `coll-list`. This supersedes the slice-2 scenario "An artifact named reports
keeps its screen" (reconciled at the archive).

#### Scenario: The organization library
- **GIVEN** a signed-in person on `/app/account`
- **WHEN** the person follows a link to `/app/isa-demo/library` and then goes back once
- **THEN** the address after the redirect is `/app/isa-demo`
- **AND** going back shows `/app/account`, not `/app/isa-demo/library`

#### Scenario: A library version with a query and a hash
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/isa-demo/library/checkout-engines/versions/2?tab=content#files`
- **THEN** the address becomes `/app/isa-demo` with no query and no hash

#### Scenario: Project resources open the collections
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/isa-demo/qos-benchmarks/resources/latency-table?revision=3`, then `/app/isa-demo/qos-benchmarks/library`
- **THEN** each address becomes `/app/isa-demo/qos-benchmarks/collections` with no query and no hash

#### Scenario: Slugs are encoded as path segments
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/isa%20demo/qos%20benchmarks/resources`, then `/app/isa%20demo/library/old%20notes`
- **THEN** the addresses become `/app/isa%20demo/qos%20benchmarks/collections` and `/app/isa%20demo`

#### Scenario: Signed out first
- **GIVEN** no session
- **WHEN** the visitor opens `/app/isa-demo/library/checkout-engines/drafts/d-1` and signs in
- **THEN** the frontend shows `/login` first, with `state.from` naming the opened address, and then `/app/isa-demo`

#### Scenario: Ties between a project slug and a library artifact
- **GIVEN** a signed-in person and the organization `isa-demo`
- **WHEN** the person opens `/app/isa-demo/library/reports`, `/app/isa-demo/library/library`, `/app/isa-demo/library/resources` and `/app/isa-demo/library/collections`
- **THEN** the first three addresses become `/app/isa-demo`
- **AND** `/app/isa-demo/library/collections` stays and renders the screen `coll-list`

#### Scenario: The targets are routed screens
- **GIVEN** the seven slice-3 entries of `RETIRED_ROUTES`, the empty query and the params `org=a`, `project=b`, `artifact=c`, `draft=d`, `version=1`, `resource=e`
- **WHEN** each target is computed and matched against `routeDefinitions`
- **THEN** the library targets are `/app/a` and resolve to the organization overview
- **AND** the project targets are `/app/a/b/collections` and resolve to `coll-list`

### Requirement: Library and resource screens are not routed
THE route registry SHALL declare none of the screen ids `lib-list`, `lib-artifact`, `lib-draft`, `lib-version`, `proj-library`, `proj-resources` and `proj-resource-detail`, nor any of their seven paths.

`req~frontend-retire-library-screens-not-routed~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`; `frontend/src/routes/d4.tsx`

The seven paths are those of the requirement "Library and resource addresses redirect". The pages are deleted with
their tests (design.md §1). The ids and paths of slices 1 and 2 stay absent.

#### Scenario: Slice 3 ids are gone
- **GIVEN** the route registry after slice 3
- **WHEN** the registry test lists the ids of `routeDefinitions`
- **THEN** none of `lib-list`, `lib-artifact`, `lib-draft`, `lib-version`, `proj-library`, `proj-resources`, `proj-resource-detail` is among them
- **AND** none of `analysis-sources`, `analysis-workspace`, `rep-list`, `rep-detail` is among them

#### Scenario: Slice 3 paths are gone
- **GIVEN** the route registry after slice 3
- **WHEN** the registry test lists the paths of `routeDefinitions`
- **THEN** no path starts with `/app/:org/library` and none is `/app/:org/:project/library`, `/app/:org/:project/resources` or `/app/:org/:project/resources/:resource`
- **AND** the D4 list of the registry test reads `case-list`, `case-detail`, `case-composer`, `case-revision`, `case-compare`, `wb-workbench`, `snap-detail`, `proj-files`, `coll-list`, `coll-detail`, `gen-lab`

### Requirement: No link leads to a library or resource address
IF a source file under `frontend/src`, other than a test file, a file under `src/test/` and `routes/retiredRoutes.tsx`, holds a string or template literal that starts with a retired path of the redirect table, or, in a file not under `src/api/`, a template literal in which a `${…}` is directly followed by the static tail of such a path, each parameter standing for one segment or one `${…}` and the match followed by the end of the literal, `/`, `?`, `#` or `${`, THEN the frontend test suite SHALL fail naming the file and the literal.

`req~frontend-retire-library-no-link~1`

Needs: impl, utest

Evidence: `frontend/src/routes/links.test.ts`; `frontend/src/pages/Resolve/Resolve.test.tsx`

The scan is the slice-2 one applied to the slice-3 entries; the static tails are `/library`, `/library/:artifact`,
`/library/:artifact/drafts/:draft`, `/library/:artifact/versions/:version`, `/resources` and `/resources/:resource`.
Files under `src/api/` keep their `/v1/…/library` and `/v1/…/resources` gateway paths. The public resolver builds the
link of a resource revision from pieces, so its own test pins it at `<base>/collections`.

#### Scenario: Full addresses and tails are reported
- **GIVEN** the slice-3 paths and the synthetic source `pages/X.tsx` holding ``const a = `/app/${org}/library`;``, `const b = '/app/acme/library/x/versions/2';` and ``const c = `${root}/resources/${slug}`;``
- **WHEN** the link scan reads it
- **THEN** it returns exactly ``pages/X.tsx: /app/${org}/library``, `pages/X.tsx: /app/acme/library/x/versions/2` and ``pages/X.tsx: ${root}/resources/${slug}``

#### Scenario: Look-alikes and gateway paths are not reported
- **GIVEN** the slice-3 paths, the synthetic source `pages/Z.tsx` holding `'/app/acme/libraryx'`, ``` `${root}/resourcesx` ``` and ``` `${root}/collections` ```, and the synthetic source `src/api/library.ts` holding ``` `/v1/orgs/${org}/library/${artifact}` ```
- **WHEN** the link scan reads them
- **THEN** it returns an empty list

#### Scenario: The application sources hold no library or resource address
- **GIVEN** the application sources after slice 3
- **WHEN** the link scan reads them with the paths of `RETIRED_ROUTES`
- **THEN** it returns an empty list
- **AND** the public resolver's `Open in platform` link of a resource revision located in `isa-demo/qos` is `/app/isa-demo/qos/collections`

### Requirement: Project tabs and palette lead to the collections, not the library
THE project tabs, the command palette and the organization-level navigation SHALL offer no tab, command or link whose address is `/app/<org>/library`, `/app/<org>/<project>/library` or `/app/<org>/<project>/resources`, alone or followed by `/`, `?` or `#`.

`req~frontend-retire-library-navigation~1`

Needs: impl, utest

Evidence: `frontend/src/components/PlatformShell/SectionNav.test.tsx`; `frontend/src/components/PlatformShell/paletteCommands.test.ts`; `frontend/src/components/PlatformShell/appNavigation.test.ts`; `frontend/src/components/PlatformShell/ProjectTabs.tsx`; `frontend/src/components/PlatformShell/paletteCommands.ts`

The tab `Library` becomes `Collections` (key `collections`, suffix `/collections`) at the same place; the project
command `Library` becomes `Collections` (`Problems grouped into suites`); the `ProjectLibraryNav` pill navigation goes.
`RESERVED_SLUGS` keeps `library` and `resources`.

#### Scenario: Project tabs of a member
- **GIVEN** a member of `isa-demo` on `/app/isa-demo/qos-benchmarks/studies`
- **WHEN** the project tabs are rendered
- **THEN** their links read `Overview`, `Cases`, `Collections`, `Jobs`, `Studies`, `Publications`, `Files`, `Package`, `Settings`
- **AND** the link `Collections` has the `href` `/app/isa-demo/qos-benchmarks/collections`
- **AND** no link is named `Library` or has an `href` that starts with `/app/isa-demo/qos-benchmarks/library` or `/app/isa-demo/qos-benchmarks/resources`

#### Scenario: Project tabs of a public visitor
- **GIVEN** a visitor reading the public project `qos-benchmarks` of `isa-demo` (access `public_read`)
- **WHEN** the project tabs are rendered
- **THEN** their links read `Overview`, `Cases`, `Collections`, `Studies`, `Publications`, `Files`

#### Scenario: The collections screen marks its tab
- **GIVEN** a member on `/app/isa-demo/qos-benchmarks/collections/checkout`
- **WHEN** the screen is rendered
- **THEN** the tab `Collections` carries `aria-current="page"`
- **AND** no navigation named `Library` is rendered

#### Scenario: Palette commands
- **GIVEN** `buildCommands` with an organization `isa-demo`, the project `qos-benchmarks` selected and an administrator
- **WHEN** the commands are built
- **THEN** one command of the group `Project` is labelled `Collections`, described `Problems grouped into suites`, with the `href` `/app/isa-demo/qos-benchmarks/collections`
- **AND** no command is labelled `Library`, and no `href` starts with `/app/isa-demo/library` or `/app/isa-demo/qos-benchmarks/library`

#### Scenario: Organization navigation
- **GIVEN** a member on `/app/isa-demo`
- **WHEN** the organization navigation is built
- **THEN** it holds no entry `library`
- **AND** `RESERVED_SLUGS` still holds `library` and `resources`

### Requirement: Library page offender leaves the allow-list
THE raw-rendering allow-list SHALL hold no entry for `pages/Library/ContentView.tsx`, with `MAX_ALLOWED_OFFENDERS` 12.

`req~frontend-retire-library-allow-list~1`

Needs: impl, utest

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`; `frontend/src/test/rawRenderingAllowList.ts`

Offender 11 (`pages/Library/ContentView.tsx`) is deleted with its screens; the ceiling rule of slice 1 keeps the
ceiling equal to the entries.

#### Scenario: Slice 3 entries
- **GIVEN** the allow-list after slice 3
- **WHEN** the hygiene test reads it
- **THEN** the offender numbers of `RAW_RENDERING_ALLOW_LIST` read 1, 2, 3, 4, 6, 8, 9, 10, 12, 13, 14, 15
- **AND** `MAX_ALLOWED_OFFENDERS` is 12 and `ceilingMismatch` returns nothing for it
- **AND** `UNLISTED_FINDINGS` holds only finding 16, `pages/Workbench/SourcePanel.tsx`
- **AND** no entry of either list names a file under `pages/Library/`

#### Scenario: The sources still pass the three checks
- **GIVEN** the application sources and the allow-list after slice 3
- **WHEN** `unlistedFindings`, `staleEntries` and `wrongLineNumbers` read them
- **THEN** each returns an empty list

### Requirement: Screen count after the library
THE route registry SHALL hold 71 screens, with 11 in domain D4.

`req~frontend-retire-library-screen-count~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`

78 after slice 2, 71 after slice 3. The other domains keep their counts; redirect entries are not screens.

#### Scenario: Slice 3 count
- **GIVEN** the route registry after slice 3
- **WHEN** the registry test counts `routeDefinitions`
- **THEN** it counts 71 screens
- **AND** the domain sizes read D1 18, D2 7, D3 10, D4 11, D5 4, D6 8, D7 4 and D8 9

#### Scenario: A screen left behind
- **GIVEN** a registry that still declares `lib-version` at `/app/:org/library/:artifact/versions/:version`
- **WHEN** the registry test runs
- **THEN** it fails, counting 72 screens instead of 71

### Requirement: No entry point into the library or the project resources
THE case composer, the case list, the case revision page, the job launch, the job detail, the organization overview, the study detail and the collections screens SHALL offer no control that opens the organization library, the project library or a project resource.

`req~frontend-retire-library-entry-points-removed~1`

Needs: impl, utest

Evidence: `frontend/src/pages/Cases/CaseComposer.test.tsx`; `frontend/src/pages/Cases/CaseList.test.tsx`; `frontend/src/pages/Cases/CaseRevision.test.tsx`; `frontend/src/pages/Jobs/JobLaunch.test.tsx`; `frontend/src/pages/Jobs/JobDetail.test.tsx`; `frontend/src/pages/Organization/OrgOverview.test.tsx`; `frontend/src/pages/Resources/CollDetail.test.tsx`

The removed controls are `Open in library`, `Find in library` and the issue action `library` (composer), `Open the
library` (case list, job launch, job detail), `Edit the candidate` and `edit the candidates` (job launch and detail),
the library links of the organization overview, `Open the definition in the library` (study detail, whose note reads
`Definition version N · sealed`), and the links of resource cards (case revision) and resource pins
(collections). The frontend API client keeps its library operations (design.md §5). Test file names follow the
existing page tests (tasks.md 3.6).

#### Scenario: Composer and case list
- **GIVEN** a member on the composer of the case `checkout-flow` in `isa-demo/qos-benchmarks` with an issue on a resource reference, then on the case list
- **WHEN** both screens are rendered
- **THEN** no link or button is named `Open in library`, `Find in library`, `library` or `Open the library`

#### Scenario: Case revision resource cards
- **GIVEN** a member on revision 2 of `checkout-flow` that pins a published, an unpublished and a withdrawn resource
- **WHEN** the screen is rendered
- **THEN** the resource cards hold no link, and their notes read `Published`, `Not published` and `Withdrawn`

#### Scenario: Job launch and job detail
- **GIVEN** a member launching a run of a package with range features, and the job detail of a run refused for ranges
- **WHEN** both screens are rendered
- **THEN** the `Engines` link stays, and no link is named `Edit the candidate`, `edit the candidates` or `Open the library`

#### Scenario: Study detail
- **GIVEN** a member on a study whose current definition version is 1
- **WHEN** the screen is rendered
- **THEN** no link is named `Open the definition in the library`
- **AND** the note reads `Definition version 1 · sealed`

#### Scenario: Organization overview and collections
- **GIVEN** a member on `/app/isa-demo` and on `/app/isa-demo/qos-benchmarks/collections/checkout`, whose revision pins the resource `latency-table`
- **WHEN** both screens are rendered
- **THEN** no link has an `href` that contains `/library` or `/resources`
- **AND** the pin `latency-table` is shown without a link
