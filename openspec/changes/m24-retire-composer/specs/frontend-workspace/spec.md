## ADDED Requirements

### Requirement: Composer address redirects to the workbench
WHEN a person opens an address that matches `/app/:org/:project/cases/:case/compose` and that neither a screen of the route registry nor an earlier entry of `RETIRED_ROUTES` matches, THE frontend SHALL replace the current history entry with `/app/<org>/<project>/workbench?case=<case>`, where `<org>`, `<project>` and `<case>` are the slugs of the opened address each percent-encoded as one path segment, with no other query parameter and no hash.

`req~frontend-retire-composer-redirect~1`

Needs: impl, utest

Evidence: `frontend/src/routes/retiredRoutes.test.tsx`; `frontend/src/routes/retiredRoutes.tsx`; `frontend/src/routes/index.tsx`

The path is the entry of slice 4 (`slice: 4`) in `frontend/src/routes/retiredRoutes.tsx`, appended after the slice-3
entries. The redirect sits behind the client-side guard and keeps `state.from`, as for slices 1 to 3. The retired routes
stay mounted after the screens. No screen ties with the path; among retired routes `lib-draft` and `lib-version` tie
with it and, being earlier, win: `/app/<org>/library/cases/drafts/compose` and
`/app/<org>/library/cases/versions/compose` open `/app/<org>` (design.md §2).

#### Scenario: The composer of a case
- **GIVEN** a signed-in member of `isa-demo` on `/app/isa-demo/qos-benchmarks/cases/checkout-flow`
- **WHEN** the person follows a link to `/app/isa-demo/qos-benchmarks/cases/checkout-flow/compose` and then goes back once
- **THEN** the address after the redirect is `/app/isa-demo/qos-benchmarks/workbench?case=checkout-flow`
- **AND** going back shows `/app/isa-demo/qos-benchmarks/cases/checkout-flow`, not the composer address

#### Scenario: A composer address with a query and a hash
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/isa-demo/qos-benchmarks/cases/checkout-flow/compose?from=2#check`
- **THEN** the address becomes `/app/isa-demo/qos-benchmarks/workbench?case=checkout-flow` with no other query parameter and no hash

#### Scenario: Slugs are encoded as path segments
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/isa%20demo/qos%20benchmarks/cases/old%20flow/compose`
- **THEN** the address becomes `/app/isa%20demo/qos%20benchmarks/workbench?case=old%20flow`

#### Scenario: Signed out first
- **GIVEN** no session
- **WHEN** the visitor opens `/app/isa-demo/qos-benchmarks/cases/checkout-flow/compose` and signs in
- **THEN** the frontend shows `/login` first, with `state.from` naming the opened address, and then `/app/isa-demo/qos-benchmarks/workbench?case=checkout-flow`

#### Scenario: Neighbouring case screens keep their addresses
- **GIVEN** a signed-in member of `isa-demo`
- **WHEN** the person opens `/app/isa-demo/qos-benchmarks/cases/checkout-flow/compare` and `/app/isa-demo/qos-benchmarks/cases/checkout-flow/revisions/2`
- **THEN** both addresses stay and render the screens `case-compare` and `case-revision`

#### Scenario: Ties with the library entries
- **GIVEN** a signed-in person and the organization `isa-demo`
- **WHEN** the person opens `/app/isa-demo/library/cases/drafts/compose` and `/app/isa-demo/library/cases/versions/compose`
- **THEN** both addresses become `/app/isa-demo`

#### Scenario: The target is a routed screen
- **GIVEN** the slice-4 entry of `RETIRED_ROUTES`, the empty query and the params `org=a`, `project=b`, `case=c`
- **WHEN** the target is computed and its path is matched against `routeDefinitions`
- **THEN** the target is `/app/a/b/workbench?case=c`
- **AND** its path resolves to `wb-workbench`

### Requirement: Composer screen is not routed
THE route registry SHALL declare neither the screen id `case-composer` nor the path `/app/:org/:project/cases/:case/compose`.

`req~frontend-retire-composer-screen-not-routed~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`; `frontend/src/routes/d4.tsx`

The page `pages/Cases/CaseComposer.tsx` is deleted with its test, its styles and the helpers only it used (design.md
§1). The ids and paths of slices 1 to 3 stay absent.

#### Scenario: Slice 4 id is gone
- **GIVEN** the route registry after slice 4
- **WHEN** the registry test lists the ids of `routeDefinitions`
- **THEN** `case-composer` is not among them
- **AND** none of `analysis-sources`, `analysis-workspace`, `rep-list`, `rep-detail`, `lib-list`, `lib-artifact`, `lib-draft`, `lib-version`, `proj-library`, `proj-resources`, `proj-resource-detail` is among them

#### Scenario: Slice 4 path is gone
- **GIVEN** the route registry after slice 4
- **WHEN** the registry test lists the paths of `routeDefinitions`
- **THEN** no path ends with `/compose`
- **AND** the D4 list of the registry test reads `case-list`, `case-detail`, `case-revision`, `case-compare`, `wb-workbench`, `snap-detail`, `proj-files`, `coll-list`, `coll-detail`, `gen-lab`

### Requirement: No link leads to the composer address
IF a source file under `frontend/src`, other than a test file, a file under `src/test/` and `routes/retiredRoutes.tsx`, holds a string or template literal that starts with `/app/:org/:project/cases/:case/compose`, or, in a file not under `src/api/`, a template literal in which a `${…}` is directly followed by `/cases/:case/compose`, each parameter standing for one segment or one `${…}` and the match followed by the end of the literal, `/`, `?`, `#` or `${`, THEN the frontend test suite SHALL fail naming the file and the literal.

`req~frontend-retire-composer-no-link~1`

Needs: impl, utest

Evidence: `frontend/src/routes/links.test.ts`; `frontend/src/pages/Cases/CaseCompare.test.tsx`

The scan is the slice-2 one applied to the slice-4 entry. The case comparison builds its link from `${base}/compose`,
with `base` holding `/cases/<slug>`, which the scan cannot see, so its own test pins the new address (design.md §4).

#### Scenario: Full address and tail are reported
- **GIVEN** the slice-4 path and the synthetic source `pages/X.tsx` holding ``const a = `/app/${org}/${project}/cases/${slug}/compose`;``, `const b = '/app/acme/demo/cases/c1/compose?from=2';` and ``const c = `${root}/cases/${encodeURIComponent(item.slug)}/compose`;``
- **WHEN** the link scan reads it
- **THEN** it returns exactly ``pages/X.tsx: /app/${org}/${project}/cases/${slug}/compose``, `pages/X.tsx: /app/acme/demo/cases/c1/compose?from=2` and ``pages/X.tsx: ${root}/cases/${encodeURIComponent(item.slug)}/compose``

#### Scenario: Look-alikes and replacements are not reported
- **GIVEN** the slice-4 path and the synthetic source `pages/Z.tsx` holding ``` `${root}/cases/${slug}/composer` ```, ``` `${root}/cases/${slug}/compare` ```, ``` `${root}/workbench?case=${slug}` ``` and `'/app/acme/demo/cases/c1'`
- **WHEN** the link scan reads it
- **THEN** it returns an empty list

#### Scenario: The application sources hold no composer address
- **GIVEN** the application sources after slice 4
- **WHEN** the link scan reads them with the paths of `RETIRED_ROUTES`
- **THEN** it returns an empty list
- **AND** the slice-4 entries of `RETIRED_ROUTES` are exactly one, with the path `/app/:org/:project/cases/:case/compose`

### Requirement: Ways to a new revision lead to the workbench
THE case list, the case detail, the case comparison and the job result SHALL offer the workbench `/app/<org>/<project>/workbench?case=<case>`, and not the composer, as the way to make a new revision of a case, through the controls that opened the composer, under their current names and to the same people.

`req~frontend-retire-composer-entry-points-repointed~1`

Needs: impl, utest

Evidence: `frontend/src/pages/Cases/CaseList.test.tsx`; `frontend/src/pages/Cases/CaseDetail.test.tsx`; `frontend/src/pages/Cases/CaseCompare.test.tsx`; `frontend/src/pages/Jobs/JobDetail.test.tsx`

The controls are `New revision` (case list, case detail, case comparison), `Compose its first revision` (case list
notice after creating a case), `Compose the first revision` (case detail) and `Try faster providers` (job result of an
infeasible run with a known case). `<case>` is the case slug, percent-encoded. A person who cannot create revisions
(`canCreate` false, a VIEWER) gets none of the case controls, as today. The texts that named the composer are reworded
(design.md §3). The job result is rendered by the job detail, whose test covers it.

#### Scenario: Case list of a member
- **GIVEN** a member on `/app/isa-demo/qos-benchmarks/cases` with the case `flujo-checkout`
- **WHEN** the screen is rendered
- **THEN** the row of `flujo-checkout` has a link `New revision` with the `href` `/app/isa-demo/qos-benchmarks/workbench?case=flujo-checkout`
- **AND** no link has an `href` that ends with `/compose`

#### Scenario: Notice after creating a case
- **GIVEN** a member on the case list
- **WHEN** the person creates the case `Análisis de latencia` (slug `analisis-de-latencia`)
- **THEN** the notice reads `Case “Análisis de latencia” created. Compose its first revision when you’re ready.`
- **AND** its link `Compose its first revision` has the `href` `/app/isa-demo/qos-benchmarks/workbench?case=analisis-de-latencia`

#### Scenario: Empty case list
- **GIVEN** a member on the case list of a project without cases
- **WHEN** the screen is rendered
- **THEN** the empty state reads `Start from a ready example, or create a case and save its first revision from the workbench.`
- **AND** no text contains `composer` or `compose one`

#### Scenario: Case detail of a member
- **GIVEN** a member on `/app/member-lab/qos-benchmarks/cases/flujo-checkout`, first with revisions, then without any
- **WHEN** the screen is rendered
- **THEN** the link `New revision`, then the link `Compose the first revision`, has the `href` `/app/member-lab/qos-benchmarks/workbench?case=flujo-checkout`

#### Scenario: Revision without a snapshot
- **GIVEN** a member on a case whose latest revision has no compiled snapshot
- **WHEN** the screen is rendered
- **THEN** the note ends `Save a new revision from the workbench to get one.`
- **AND** no text contains `composer`

#### Scenario: A viewer gets no way to a new revision
- **GIVEN** a VIEWER of `isa-demo` on the case list, on the case `flujo-checkout` with and without revisions, and on its comparison
- **WHEN** the screens are rendered
- **THEN** no link is named `New revision`, `Compose its first revision` or `Compose the first revision`
- **AND** no link has an `href` that contains `/workbench?case=`

#### Scenario: Case comparison
- **GIVEN** a member on `/app/isa-demo/qos-benchmarks/cases/flujo-checkout/compare` comparing revisions 1 and 2
- **WHEN** the screen is rendered
- **THEN** the link `New revision` has the `href` `/app/isa-demo/qos-benchmarks/workbench?case=flujo-checkout`

#### Scenario: Job result of an infeasible run
- **GIVEN** a member on the job detail of an infeasible run of revision 3 of the case `flujo` in `isa-demo/qos-benchmarks`
- **WHEN** the screen is rendered
- **THEN** the link `Try faster providers` has the `href` `/app/isa-demo/qos-benchmarks/workbench?case=flujo`
- **AND** the link `See the rules` still has the `href` `/app/isa-demo/qos-benchmarks/cases/flujo/revisions/3`

### Requirement: Screen count after the composer
THE route registry SHALL hold 70 screens, with 10 in domain D4.

`req~frontend-retire-composer-screen-count~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`

71 after slice 3, 70 after slice 4. The other domains keep their counts; redirect entries are not screens.

#### Scenario: Slice 4 count
- **GIVEN** the route registry after slice 4
- **WHEN** the registry test counts `routeDefinitions`
- **THEN** it counts 70 screens
- **AND** the domain sizes read D1 18, D2 7, D3 10, D4 10, D5 4, D6 8, D7 4 and D8 9

#### Scenario: A screen left behind
- **GIVEN** a registry that still declares `case-composer` at `/app/:org/:project/cases/:case/compose`
- **WHEN** the registry test runs
- **THEN** it fails, counting 71 screens instead of 70
