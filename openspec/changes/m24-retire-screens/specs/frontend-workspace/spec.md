## ADDED Requirements

### Requirement: Retired screens are not routed
THE route registry SHALL declare no screen whose id or path belongs to a screen retired by a delivered slice of M2.4.

`req~frontend-retire-screens-not-routed~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`; `frontend/src/routes/d6.tsx`

A retired address is answered by the redirect table, never by a screen.

#### Scenario: Slice 1 ids are gone
- **GIVEN** the route registry after slice 1, whose retired screens are `analysis-sources` at `/app/analysis` and `analysis-workspace` at `/app/analysis/workspace` (pages in `frontend/src/pages/Analysis/`; slices 2–5 add the report editor, the library catalogue and project resources, the composer and sponsorship)
- **WHEN** the registry test lists the ids of `routeDefinitions`
- **THEN** neither `analysis-sources` nor `analysis-workspace` is among them
- **AND** a retired address is answered by the redirect table (requirement "Old addresses redirect through one table"), never by a screen

#### Scenario: Slice 1 paths are gone
- **GIVEN** the route registry after slice 1
- **WHEN** the registry test lists the paths of `routeDefinitions`
- **THEN** neither `/app/analysis` nor `/app/analysis/workspace` is among them
- **AND** the D6 list of the registry test reads `study-list`, `study-builder`, `study-detail`, `study-run`, `study-cell`, `study-analytics`, `rep-list`, `rep-detail`, `proj-publications`, `verifier`

### Requirement: Old addresses redirect through one table
WHEN a person opens an address whose path is a retired path of `frontend/src/routes/retiredRoutes.tsx`, THE frontend SHALL replace the current history entry with the target that the table's rule for that path computes from the query, without rendering a retired screen.

`req~frontend-retire-redirect-generic~1`

Needs: impl, utest

Evidence: `frontend/src/routes/retiredRoutes.test.tsx` (new); `frontend/src/routes/AppRoutes.test.tsx`

#### Scenario: The history entry is replaced
- **GIVEN** the table, the only place that knows retired addresses and whose targets are absolute addresses of routed screens, which every slice extends, behind the client-side guard (living requirement "Client-side guard"), and a retired path that takes precedence over `/app/:org` and `/app/:org/:project`
- **GIVEN** a signed-in person on `/app/account` who follows a link to `/app/analysis/workspace?job=job-done-3`
- **WHEN** the redirect runs and the person goes back once
- **THEN** the address after the redirect is `/app/jobs`
- **AND** going back shows `/app/account`, not `/app/analysis/workspace?job=job-done-3`

#### Scenario: No retired screen and no organization page
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/analysis`
- **THEN** no heading `Analysis` or `Decision space` is rendered
- **AND** the organization page of an organization named `analysis` is not rendered

#### Scenario: Signed out first
- **GIVEN** no session
- **WHEN** the visitor opens `/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds` and signs in
- **THEN** the frontend shows `/login` first and then `/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds`

#### Scenario: Every target is a routed screen
- **GIVEN** every entry of `RETIRED_ROUTES`, and the empty query, `org=a&project=b&study=c` and `org=a&project=b&study=c&run=d`
- **WHEN** each target is computed and matched against `routeDefinitions`
- **THEN** each target resolves to a routed screen
- **AND** no retired path of the table is the path of a route definition

### Requirement: Decision-space addresses redirect to the study or the job history
WHEN a person opens `/app/analysis` or `/app/analysis/workspace`, THE frontend SHALL redirect to the study run if the query carries `org`, `project`, `study` and `run`, otherwise to the study if it carries `org`, `project` and `study`, otherwise to `/app/jobs`, with no query in the target.

`req~frontend-retire-redirect-decision-space~1`

Needs: impl, utest

Evidence: `frontend/src/routes/retiredRoutes.test.tsx` (new)

Both paths follow the same rule.

#### Scenario: A study run
- **GIVEN** a signed-in person, the study run being `/app/<org>/<project>/studies/<study>/runs/<run>` and the study `/app/<org>/<project>/studies/<study>`; "carries" means the key is present with a non-empty value, the first value of a repeated key is used, each value is percent-encoded as one path segment and every other query parameter (`job`, `report`, `cell`, any unknown one) is dropped
- **WHEN** the person opens `/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=run-1&cell=cell-3`
- **THEN** the address becomes `/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds/runs/run-1` with no query

#### Scenario: A study
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/analysis/workspace?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds`
- **THEN** the address becomes `/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds`

#### Scenario: A run without its study
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/analysis?org=isa-demo&project=qos-benchmarks&run=run-1`
- **THEN** the address becomes `/app/jobs`

#### Scenario: Jobs and reports go to the job history
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/analysis/workspace?job=job-done-1&job=job-done-3`, then `/app/analysis/workspace?report=isa-demo%2Fqos-benchmarks%2Fdecision-choice`, then `/app/analysis`
- **THEN** each address becomes `/app/jobs` with no query

#### Scenario: Empty values count as absent
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/analysis?org=isa-demo&project=qos-benchmarks&study=&run=run-1`
- **THEN** the address becomes `/app/jobs`

#### Scenario: Values are encoded as path segments
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/analysis?org=isa-demo&project=qos-benchmarks&study=seeds%2F2026&study=other`
- **THEN** the address becomes `/app/isa-demo/qos-benchmarks/studies/seeds%2F2026`

### Requirement: No link leads to a retired address
IF a non-test source file under `frontend/src` other than `routes/retiredRoutes.tsx` holds a string or template literal that starts with a retired path of the redirect table, THEN the frontend test suite SHALL fail naming the file and the literal.

`req~frontend-retire-no-link-to-retired~1`

Needs: impl, utest

Evidence: `frontend/src/routes/links.test.ts`

This covers every literal, not only `to`, `href` and `navigate`.

#### Scenario: A link in a variable is reported
- **GIVEN** that files under `src/test/` are exempt, that the retired path must be followed by the end of the literal, `/`, `?`, `#` or `${`, and that an address kept in a variable is a link too; the slice 1 literals removed or re-pointed are those of the job detail, job list, job history, binding analysis card, study analytics and report page (design.md §3); an address built from pieces (`'/app/' + 'analysis'`) is a known limit (design.md §6)
- **AND** the synthetic source `pages/X.tsx` holding ``const href = `/app/analysis/workspace?job=${id}`;`` and the retired paths `/app/analysis` and `/app/analysis/workspace`
- **WHEN** the link scan reads it
- **THEN** it returns exactly ``pages/X.tsx: /app/analysis/workspace?job=${id}``

#### Scenario: Look-alike addresses are not reported
- **GIVEN** the synthetic sources holding `'/app/analysisx'`, `'/v1/analysis/sources'` and `'/app/:org/:project/studies'`
- **WHEN** the link scan reads them
- **THEN** it returns an empty list
- **AND** `'/app/analysis'` and `"/app/analysis#top"` in a synthetic source are each reported once

#### Scenario: The table itself is exempt
- **GIVEN** the synthetic source `routes/retiredRoutes.tsx` holding `'/app/analysis'`
- **WHEN** the link scan reads it
- **THEN** it returns an empty list

#### Scenario: The application sources hold no retired address
- **GIVEN** the application sources after slice 1
- **WHEN** the link scan reads them
- **THEN** it returns an empty list
- **AND** the job detail of the completed job `job-done-3`, the job history row of `job-done-1`, the job list with `job-done-3` selected, the binding analysis card of `job-a`, the study analytics page and a report holding a decision render no link named `Analyze`, `Analyze 1 selected`, `Open analysis`, `Weigh trade-offs` or `Reopen decision space`

### Requirement: Main navigation without retired screens
THE main navigation SHALL offer no entry whose address is a retired path of the redirect table, alone or followed by `/`, `?` or `#`.

`req~frontend-retire-navigation~1`

Needs: impl, utest

Evidence: `frontend/src/components/PlatformShell/appNavigation.test.ts`; `frontend/src/components/PlatformShell/AppHeader.test.tsx`

For slice 1 the entry `Analysis` goes; the other entries keep their order.

#### Scenario: No Analysis entry
- **GIVEN** a signed-in person on `/app/jobs`; for slice 1 the entry `Analysis` (`/app/analysis`) and its section of the current-section rule go
- **WHEN** the application header is rendered
- **THEN** its navigation has no link named `Analysis`
- **AND** no link of the header has an `href` that starts with `/app/analysis`

#### Scenario: Main links
- **GIVEN** the main links of `appNavigation.ts`
- **WHEN** they are listed
- **THEN** their addresses are `/app`, `/app/jobs`, `/explore` and `/app/admin`, and none is a retired path

### Requirement: Command palette without retired screens
THE command palette SHALL offer no command whose address is a retired path of the redirect table, alone or followed by `/`, `?` or `#`.

`req~frontend-retire-palette~1`

Needs: impl, utest

Evidence: `frontend/src/components/PlatformShell/paletteCommands.test.ts` (new); `frontend/src/components/PlatformShell/CommandPalette.test.tsx`

For slice 1 the command `Go to › Analysis` goes.

#### Scenario: No Analysis command
- **GIVEN** that commands built from loaded data (organizations, projects) follow the same rule, and `buildCommands` with an organization `isa-demo`, a project `qos-benchmarks` selected and an administrator
- **WHEN** the commands are built
- **THEN** no command is labelled `Analysis`
- **AND** no command has an `href` that is `/app/analysis` or starts with `/app/analysis/`, `/app/analysis?` or `/app/analysis#`

### Requirement: Offenders leave the allow-list with their screens
THE raw-rendering allow-list SHALL hold no entry for a raw-rendering line that a delivered slice of M2.4 removed with its screens.

`req~frontend-retire-allow-list-leaves~1`

Needs: impl, utest

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`; `frontend/src/test/rawRenderingAllowList.ts`

A stale entry already fails the hygiene test (requirement "Raw-rendering hygiene with a shrinking allow-list" of the change `m21-rendering-catalogue`).

#### Scenario: Slice 1 entries are gone
- **GIVEN** the allow-list after slice 1, where offender 7 (`pages/Analysis/Inspector.tsx`, deleted) leaves `RAW_RENDERING_ALLOW_LIST` and unlisted finding 17 (`pages/Analysis/SavedDecision.tsx`, whose decision view moves to the report page without `JSON.stringify`, design.md §4) leaves `UNLISTED_FINDINGS`; offenders 5 and 11 leave with slices 2 and 3
- **WHEN** the hygiene test reads it
- **THEN** the offender numbers of `RAW_RENDERING_ALLOW_LIST` read 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15
- **AND** `UNLISTED_FINDINGS` holds only finding 16, `pages/Workbench/SourcePanel.tsx`
- **AND** no entry of either list names a file under `pages/Analysis/`

#### Scenario: The sources still pass the three checks
- **GIVEN** the application sources after slice 1 and the allow-list after slice 1
- **WHEN** `unlistedFindings`, `staleEntries` and `wrongLineNumbers` read them
- **THEN** each returns an empty list

### Requirement: Allow-list ceiling equals its entries
IF `MAX_ALLOWED_OFFENDERS` in `frontend/src/test/rawRenderingAllowList.ts` differs from the number of entries of `RAW_RENDERING_ALLOW_LIST`, THEN the hygiene test SHALL fail naming both numbers.

`req~frontend-retire-allow-list-ceiling~1`

Needs: impl, utest

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`

The ceiling drops by the number of offenders each slice removes.

#### Scenario: Slice 1 ceiling
- **GIVEN** the allow-list after slice 1, where the ceiling drops from 15 to 14, the offender numbers are a strictly increasing subset of 1–15 and `UNLISTED_FINDINGS` is not counted
- **WHEN** the hygiene test reads it
- **THEN** `MAX_ALLOWED_OFFENDERS` is 14 and `RAW_RENDERING_ALLOW_LIST` has 14 entries

#### Scenario: A ceiling left high
- **GIVEN** a ceiling of 15 and 14 entries
- **WHEN** `ceilingMismatch` reads them
- **THEN** it returns `MAX_ALLOWED_OFFENDERS is 15 but the allow-list has 14 entries`

#### Scenario: A ceiling set too low
- **GIVEN** a ceiling of 13 and 14 entries
- **WHEN** `ceilingMismatch` reads them
- **THEN** it returns `MAX_ALLOWED_OFFENDERS is 13 but the allow-list has 14 entries`
- **AND** for a ceiling of 14 and 14 entries it returns nothing

### Requirement: Screen count drops with the retirements
THE route registry SHALL hold 82 screens minus the screens retired by the delivered slices of M2.4.

`req~frontend-retire-screen-count~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`

82 is the count before M2.4. After slice 1 (two screens) the registry holds 80, and domain D6 holds 10 instead of 12;
the other domains keep their counts. The redirect entries of `retiredRoutes.tsx` are not screens and are not counted.

#### Scenario: Slice 1 count
- **GIVEN** the route registry after slice 1
- **WHEN** the registry test counts `routeDefinitions`
- **THEN** it counts 80 screens
- **AND** the domain sizes read D1 18, D2 7, D3 10, D4 18, D5 4, D6 10, D7 4 and D8 9

#### Scenario: A screen left behind
- **GIVEN** a registry that still declares `analysis-workspace` at `/app/analysis/workspace`
- **WHEN** the registry test runs
- **THEN** it fails, counting 81 screens instead of 80

### Requirement: Gateway untouched by screen retirements
THE screen retirements of M2.4 SHALL leave the gateway's endpoints and their responses unchanged, with no `Deprecation` or `Sunset` header added.

`req~frontend-retire-gateway-untouched~1`

Evidence: the diff of the PR (no changed path under `openbinding-gateway/`, `engines/` or `docs/openapi.json`) checked by the reviewer; the gateway tests of `/v1/analysis/*` keep passing

#### Scenario: Slice 1 diff
- **GIVEN** the diff of the slice-1 PR against `develop`; no frontend code or test covers this requirement (no `Needs:`), it is a constraint on the diff checked by the reviewer; retiring the endpoints, their `Deprecation` and `Sunset` headers, the `analysis` queue and its worker need an owner CRP (ROADMAP M2.4, M9.6, ADR-0020 decision 5) and are not part of this change; no file under `openbinding-gateway/` and no operation of `docs/openapi.json` changes; the gateway's own tests are untouched
- **WHEN** its changed paths are listed
- **THEN** none is under `openbinding-gateway/`, `engines/` or `docs/openapi.json`

#### Scenario: The analysis endpoints still answer
- **GIVEN** the gateway built from the slice-1 PR head
- **WHEN** its tests of `/v1/analysis/sources` and the other `/v1/analysis/*` operations (`test_binding_analysis.py`, `test_archive_analysis.py`, `test_apikey_analysis_scopes.py` under `openbinding-gateway/tests/`) run
- **THEN** they pass as on `develop`
- **AND** no response of those operations carries a `Deprecation` or `Sunset` header
