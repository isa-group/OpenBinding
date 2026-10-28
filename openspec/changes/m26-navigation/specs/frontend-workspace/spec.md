## ADDED Requirements

### Requirement: Routes declared per area
THE frontend SHALL declare each screen and each moved address in exactly one area file `src/routes/areas/<area>.tsx` that comes with its own expectations test `src/routes/areas/<area>.test.ts` pinning the ids and paths of that area.

`req~frontend-nav-route-areas~1`

Needs: impl, utest

Notes: design.md §11.1.

#### Scenario: The registry is the union of the areas
- **GIVEN** the fourteen area files
- **WHEN** the registry test lists the ids of `routeDefinitions`
- **THEN** the list equals the screens of `public`, `auth`, `verify`, `system`, `language`, `engines`, `account`, `organizations`, `project`, `problems`, `collections`, `runs`, `studies` and `admin`, concatenated in that order
- **AND** every id and every path appears once

#### Scenario: An area file without its test
- **GIVEN** an area file `src/routes/areas/extra.tsx` and no file `src/routes/areas/extra.test.ts`
- **WHEN** the Vitest suite runs
- **THEN** the route-areas test fails naming `extra`

#### Scenario: A screen declared in two areas
- **GIVEN** the screen id `eng-catalog` declared in `areas/engines.tsx` and again in `areas/public.tsx`
- **WHEN** the Vitest suite runs
- **THEN** the route-areas test fails naming `eng-catalog` and both areas

#### Scenario: The domain files are gone
- **GIVEN** the sources after the change
- **WHEN** the test lists the files that match `src/routes/d[1-8].tsx`
- **THEN** it lists none
- **AND** no source imports `routesByDomain`

### Requirement: Moved addresses redirect
WHEN a person opens an address that matches an entry of the moved-routes table, THE frontend SHALL replace the current history entry with the target address of that entry, whether or not the person is signed in.

`req~frontend-nav-redirects~1`

Needs: impl, utest

Notes: design.md §11.2; the entries are in design.md §3.

#### Scenario: A public address while signed out
- **GIVEN** no session and a visitor on `/pricing`
- **WHEN** the visitor follows a link to `/status` and then goes back once
- **THEN** the address after the redirect is `/about`
- **AND** going back shows `/pricing`
- **AND** `/login` is never shown

#### Scenario: An application address keeps its query and hash
- **GIVEN** a signed-in member of `acme`
- **WHEN** the person opens `/app/acme/demo/jobs?state=failed#latest`
- **THEN** the address becomes `/app/acme/demo/runs?state=failed#latest`

#### Scenario: An application address while signed out
- **GIVEN** no session
- **WHEN** the visitor opens `/app/acme/demo/jobs?state=failed` and signs in
- **THEN** the frontend shows `/login` first, with `state.from` naming `/app/acme/demo/runs?state=failed`
- **AND** after sign-in the address is `/app/acme/demo/runs?state=failed`

#### Scenario: Every target is a routed screen
- **GIVEN** every entry of the moved-routes table, with `org=acme`, `project=demo` and a value `x1` for every other path parameter
- **WHEN** each target is computed and its path is matched against `routeDefinitions`
- **THEN** each target path resolves to a screen of the registry
- **AND** no target path matches another entry of the moved-routes table or of `RETIRED_ROUTES`

#### Scenario: Links to moved addresses
- **GIVEN** the moved-routes table and the synthetic source `pages/X.tsx` holding `'/app/acme/demo/jobs'`, ``` `${root}/publications` ``` and `'/resolve/report/sha256-1111111111111111111111111111111111111111111111111111111111111111'`
- **WHEN** the link scan reads it
- **THEN** it returns exactly `pages/X.tsx: /app/acme/demo/jobs` and ``pages/X.tsx: ${root}/publications``
- **AND** the `/resolve/...` literal is not reported, because its entry is `permanent`

#### Scenario: A permanent entry removed
- **GIVEN** a moved-routes table without the entry for `/password-reset/complete`
- **WHEN** the Vitest suite runs
- **THEN** the redirect test fails naming `/password-reset/complete` as a permanent address

### Requirement: At most 45 routed screens
THE production route registry SHALL hold at most 45 screens.

`req~frontend-nav-screen-budget~1`

Needs: impl, utest

Notes: design.md §11.3; the count per area is in design.md §2.

#### Scenario: Count after M2.6
- **GIVEN** the production route registry after the change
- **WHEN** the budget test counts `routeDefinitions`
- **THEN** it counts 45 screens
- **AND** the area sizes read public 4, auth 5, verify 1, system 0, language 1, engines 5, account 1, organizations 3, project 3, problems 4, collections 2, runs 5, studies 3 and admin 8

#### Scenario: One screen too many
- **GIVEN** a production registry that declares a 46th screen `x-extra` at `/x-extra`
- **WHEN** the budget test runs
- **THEN** it fails reporting 46 screens against a ceiling of 45

#### Scenario: Redirects and development screens are not counted
- **GIVEN** the registry of a development build, which also holds `sys-states`
- **WHEN** the budget test counts the screens of the production registry
- **THEN** `sys-states` and the entries of the moved-routes table and of `RETIRED_ROUTES` are not counted

### Requirement: System-states screen only in development builds
WHERE the frontend is built for production, THE frontend SHALL contain neither the route nor the page of the system-states screen `sys-states`.

`req~frontend-nav-system-states-dev-only~1`

Needs: impl, utest

Notes: design.md §11.4.

#### Scenario: Development server
- **GIVEN** the development server and a signed-in person
- **WHEN** the person opens `/app/system/states`
- **THEN** the screen `sys-states` is rendered with the heading `States and recoverable errors`

#### Scenario: Production build
- **GIVEN** the production build served as a preview and a signed-in person
- **WHEN** the person opens `/app/system/states`
- **THEN** the screen `sys-states` is not rendered and the heading `States and recoverable errors` is not shown

#### Scenario: Production bundle
- **GIVEN** the output of `pnpm build`
- **WHEN** the files under `frontend/dist` are searched for `States and recoverable errors`
- **THEN** no file matches
- **AND** the production `routeDefinitions` hold no `sys-states`

### Requirement: Account sections on one page
THE account page `acct-profile` SHALL serve the sections Profile, Plan, API keys, Identities and Notifications at `/app/account/:section?`, where no segment opens Profile and the segments `usage`, `keys`, `identities` and `notifications` open the other four in that order.

`req~frontend-nav-account-sections~1`

Needs: impl, utest

Notes: design.md §11.5.

#### Scenario: Each section at its address
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/account`, `/app/account/usage`, `/app/account/keys`, `/app/account/identities` and `/app/account/notifications`
- **THEN** each address resolves to `acct-profile`
- **AND** the account navigation marks `Profile`, `Plan`, `API keys`, `Identities` and `Notifications` respectively with `aria-current="page"`

#### Scenario: New API key as a dialog
- **GIVEN** a signed-in person on `/app/account/keys`
- **WHEN** the person opens `/app/account/keys/new`
- **THEN** the address becomes `/app/account/keys?create=key`
- **AND** the dialog `New API key` is open over the API keys section
- **AND** closing the dialog leaves the address `/app/account/keys`

#### Scenario: Former account screens are not routed
- **GIVEN** the route registry after the change
- **WHEN** the account area test lists its screens
- **THEN** it lists only `acct-profile` with the path `/app/account/:section?`
- **AND** none of `acct-usage`, `acct-keys`, `acct-key-new`, `acct-identities` and `acct-notifications` is declared

#### Scenario: Unknown section
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/account/billing`
- **THEN** the heading `Page not found` is shown

### Requirement: Organization settings sections on one page
THE organization settings page `org-settings` SHALL serve the sections General, Members and Audit at `/app/:org/settings/:section?`, where no segment opens General and the segments `members` and `audit` open Members and Audit.

`req~frontend-nav-org-settings-sections~1`

Needs: impl, utest

#### Scenario: Each section at its address
- **GIVEN** an owner of `acme`
- **WHEN** the person opens `/app/acme/settings`, `/app/acme/settings/members` and `/app/acme/settings/audit`
- **THEN** each address resolves to `org-settings`
- **AND** the settings navigation marks `General`, `Members` and `Audit` respectively with `aria-current="page"`

#### Scenario: Former organization screens are not routed
- **GIVEN** the route registry after the change
- **WHEN** the organizations area test lists its screens
- **THEN** it lists `app-home`, `org-overview` and `org-settings`, the last with the path `/app/:org/settings/:section?`
- **AND** neither `org-members` nor `org-audit` is declared

#### Scenario: Unknown section
- **GIVEN** an owner of `acme`
- **WHEN** the person opens `/app/acme/settings/billing`
- **THEN** the heading `Page not found` is shown

### Requirement: Organizations and projects created in dialogs
WHEN a person starts creating an organization or a project, THE frontend SHALL open a creation dialog over the current screen, with the query `create=organization` or `create=project` in the address, instead of a routed creation screen.

`req~frontend-nav-create-dialogs~1`

Needs: impl, utest

Notes: design.md §11.6.

#### Scenario: New organization from the workspace home
- **GIVEN** a signed-in person on `/app`
- **WHEN** the person activates `New organization`
- **THEN** the address becomes `/app?create=organization` and the dialog `New organization` is open
- **AND** creating the organization `lab-two` closes the dialog and opens `/app/lab-two`

#### Scenario: Cancelled dialog
- **GIVEN** the dialog `New organization` open on `/app?create=organization`
- **WHEN** the person activates `Cancel`
- **THEN** the address becomes `/app` and the focus returns to `New organization`
- **AND** no request creates an organization

#### Scenario: New project from the organization overview
- **GIVEN** an owner of `acme` on `/app/acme`
- **WHEN** the person activates `New project` and creates the project `demo-two`
- **THEN** the dialog `New project` was open at `/app/acme?create=project`
- **AND** the address after creation is `/app/acme/demo-two`

#### Scenario: Old creation addresses
- **GIVEN** a signed-in owner of `acme`
- **WHEN** the person opens `/app/organizations/new` and `/app/acme/new-project`
- **THEN** the addresses become `/app?create=organization` and `/app/acme?create=project`
- **AND** the matching dialog is open on each

#### Scenario: Creation screens are not routed
- **GIVEN** the route registry after the change
- **WHEN** the registry test lists its ids
- **THEN** neither `org-create` nor `proj-create` is among them

### Requirement: Project tabs
THE project screens SHALL show the tabs Overview, Problems, Collections, Runs, Studies, Published and Settings, the last one holding the sections General and Members at `/app/:org/:project/settings/:section?`.

`req~frontend-nav-project-tabs~1`

Needs: impl, utest

Notes: design.md §11.7.

#### Scenario: Tabs of a member
- **GIVEN** a member of `acme` on `/app/acme/demo/studies`
- **WHEN** the project tabs are rendered
- **THEN** their links read `Overview`, `Problems`, `Collections`, `Runs`, `Studies`, `Published`, `Settings`
- **AND** their `href` values are `/app/acme/demo`, `/app/acme/demo/problems`, `/app/acme/demo/collections`, `/app/acme/demo/runs`, `/app/acme/demo/studies`, `/app/acme/demo/published` and `/app/acme/demo/settings`
- **AND** `Studies` carries `aria-current="page"`

#### Scenario: Tabs of a public visitor
- **GIVEN** a visitor reading the public project `demo` of `acme` (access `public_read`)
- **WHEN** the project tabs are rendered
- **THEN** their links read `Overview`, `Problems`, `Collections`, `Studies`, `Published`

#### Scenario: Settings sections
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/settings` and `/app/acme/demo/settings/members`
- **THEN** both resolve to `proj-settings`, marking `General` and `Members` respectively with `aria-current="page"`
- **AND** the Members section lists the members of `acme` and links `Manage members` to `/app/acme/settings/members`

#### Scenario: Published results address
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/publications`
- **THEN** the address becomes `/app/acme/demo/published`
- **AND** the tab `Published` carries `aria-current="page"`

#### Scenario: Former tabs are gone
- **GIVEN** a member of `acme` on `/app/acme/demo`
- **WHEN** the project tabs are rendered
- **THEN** no tab reads `Cases`, `Jobs`, `Publications`, `Files` or `Package`

### Requirement: Project files and package screens retired
THE frontend SHALL offer the package export and the package import of a project in the General section of the project settings instead of the screens `proj-files` and `proj-package`.

`req~frontend-nav-files-retired~1`

Needs: impl, utest

Notes: design.md §11.8.

#### Scenario: Package export and import in Settings
- **GIVEN** a member of `acme` who may change the project `demo`, on `/app/acme/demo/settings`
- **WHEN** the General section is rendered
- **THEN** it holds the sections `Export package` and `Import package`
- **AND** exporting as ZIP sends `GET /v1/organizations/acme/projects/demo/package?format=zip`, and importing a ZIP sends `POST /v1/organizations/acme/projects/demo/package`, as the package screen did

#### Scenario: Old addresses
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/files` and `/app/acme/demo/package`
- **THEN** the addresses become `/app/acme/demo` and `/app/acme/demo/settings`

#### Scenario: The screens are not routed
- **GIVEN** the route registry after the change
- **WHEN** the project area test lists its screens
- **THEN** it lists `proj-overview`, `proj-settings` and `proj-publications`
- **AND** neither `proj-files` nor `proj-package` is declared

### Requirement: Language hub
THE Language hub `lang-profiles` SHALL serve the sections Profiles and dialects, Schemas and Extensions at `/language/:section?/:item?`, where no segment opens Profiles and dialects, `schemas` opens Schemas with the schema named by `:item`, and `extensions` opens Extensions.

`req~frontend-nav-language-hub~1`

Needs: impl, utest

Notes: design.md §11.9.

#### Scenario: Sections at their addresses
- **GIVEN** a signed-in person
- **WHEN** the person opens `/language`, `/language/schemas/Application` and `/language/extensions`
- **THEN** each address resolves to `lang-profiles`
- **AND** the hub navigation marks `Profiles and dialects`, `Schemas` and `Extensions` respectively with `aria-current="page"`
- **AND** the Schemas section shows the schema `Application`

#### Scenario: Extensions while signed out
- **GIVEN** no session
- **WHEN** the visitor opens `/language/extensions`
- **THEN** the text `Log in to see and manage language extensions` is shown with a link to `/login`
- **AND** no request for registered resources is sent

#### Scenario: Old extensions address
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/language/extensions`
- **THEN** the address becomes `/language/extensions`

#### Scenario: Former language screens are not routed
- **GIVEN** the route registry after the change
- **WHEN** the language area test lists its screens
- **THEN** it lists only `lang-profiles` with the path `/language/:section?/:item?`
- **AND** neither `lang-schemas` nor `lang-extensions` is declared

#### Scenario: Link to the editor
- **GIVEN** a visitor on `/language`
- **WHEN** the hub is rendered
- **THEN** a link leads to `/workbench`

### Requirement: Examples in Explore
THE Explore page `pub-explore` SHALL show the BIM examples as its section `examples` at `/explore/examples`, with the path `/explore/:section?` for the page.

`req~frontend-nav-examples-in-explore~1`

Needs: impl, utest

Notes: design.md §11.10.

#### Scenario: The examples section
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/explore/examples`
- **THEN** the heading `BIM examples` and the list of examples are shown
- **AND** the Explore navigation marks `BIM examples` with `aria-current="page"`
- **AND** each example offers a link to `/workbench?example=<its path>`

#### Scenario: Old examples address
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/examples?profile=placement`
- **THEN** the address becomes `/explore/examples?profile=placement`

#### Scenario: The examples screen is not routed
- **GIVEN** the route registry after the change
- **WHEN** the registry test lists its ids
- **THEN** `lang-examples` is not among them
- **AND** `pub-explore` has the path `/explore/:section?`

#### Scenario: Unknown Explore section
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/explore/everything`
- **THEN** the heading `Page not found` is shown

### Requirement: Public status page retired
WHEN a visitor opens `/status`, THE frontend SHALL replace the current history entry with `/about`, where a one-line service-status note takes the place of the retired status screen.

`req~frontend-nav-status-retired~1`

Needs: impl, utest

Notes: design.md §11.11.

#### Scenario: Redirect
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/status`
- **THEN** the address becomes `/about`

#### Scenario: Note on About
- **GIVEN** a gateway whose check reports every dependency up
- **WHEN** a visitor opens `/about`
- **THEN** the text `Service status: All systems operational` is shown

#### Scenario: Gateway not answering
- **GIVEN** a gateway that does not answer the check
- **WHEN** a visitor opens `/about`
- **THEN** the text `Service status: not available right now` is shown
- **AND** the rest of the page is rendered

#### Scenario: Screen and links gone
- **GIVEN** the route registry and the site footer after the change
- **WHEN** the tests read them
- **THEN** `pub-status` is not declared
- **AND** no link of the footer or the headers has the `href` `/status`

### Requirement: One password-reset screen
THE password-reset screen `auth-reset-request` at `/password-reset` SHALL show the new-password form when the query holds a non-empty `token` and the reset-request form otherwise.

`req~frontend-nav-reset-single-screen~1`

Needs: impl, utest

Notes: design.md §11.12.

#### Scenario: Request form
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/password-reset`
- **THEN** the heading `Forgot your password?` and the field `Email address` are shown

#### Scenario: New-password form
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/password-reset?token=abc123`
- **THEN** the fields `New password` and `Confirm password` are shown
- **AND** submitting sends the token `abc123` with the new password

#### Scenario: Link of a reset e-mail
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/password-reset/complete?token=abc123`
- **THEN** the address becomes `/password-reset?token=abc123`
- **AND** the fields `New password` and `Confirm password` are shown

#### Scenario: Empty token
- **GIVEN** a visitor without a session
- **WHEN** the visitor opens `/password-reset?token=`
- **THEN** the heading `Forgot your password?` is shown

#### Scenario: The second screen is not routed
- **GIVEN** the route registry after the change
- **WHEN** the auth area test lists its screens
- **THEN** it lists `auth-login`, `auth-register`, `auth-reset-request`, `auth-cas-callback` and `org-invite-accept`

### Requirement: Study page with tabs
THE study page `study-detail` SHALL serve the tabs Setup, Progress, Results and Publish at `/app/:org/:project/studies/:study/:tab?`, showing the study run named by the query `run`, or the latest study run when the query names none.

`req~frontend-nav-study-page~1`

Needs: impl, utest

Notes: design.md §11.13.

#### Scenario: Tabs of a study with runs
- **GIVEN** a member of `acme` and the study `s1` of `demo` with the study runs `r1` and `r2`, `r2` the latest
- **WHEN** the person opens `/app/acme/demo/studies/s1`
- **THEN** the tabs read `Setup`, `Progress`, `Results`, `Publish`, and `Progress` is selected
- **AND** the run selector shows `r2`

#### Scenario: A study without runs
- **GIVEN** a member of `acme` and the study `s0` of `demo` with no study run
- **WHEN** the person opens `/app/acme/demo/studies/s0`
- **THEN** the tab `Setup` is selected

#### Scenario: Choosing a study run
- **GIVEN** a member on `/app/acme/demo/studies/s1/results`
- **WHEN** the person chooses `r1` in the run selector
- **THEN** the address becomes `/app/acme/demo/studies/s1/results?run=r1`
- **AND** the results shown are those of `r1`

#### Scenario: Old study run addresses
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/studies/s1/runs/r1`, `/app/acme/demo/studies/s1/runs/r1/analytics` and `/app/acme/demo/studies/s1/runs/r1/cells/c7`
- **THEN** the addresses become `/app/acme/demo/studies/s1/progress?run=r1`, `/app/acme/demo/studies/s1/results?run=r1` and `/app/acme/demo/studies/s1/results?run=r1&cell=c7`

#### Scenario: A cell opens its run
- **GIVEN** a member on `/app/acme/demo/studies/s1/results?run=r1&cell=c7`, the cell `c7` having run as the run `j9`
- **WHEN** the Results tab is rendered
- **THEN** the cell `c7` is shown with a link `Open run` to `/app/acme/demo/runs/j9`

#### Scenario: Former study screens are not routed
- **GIVEN** the route registry after the change
- **WHEN** the studies area test lists its screens
- **THEN** it lists `study-list`, `study-builder` and `study-detail`, the last with the path `/app/:org/:project/studies/:study/:tab?`
- **AND** none of `study-run`, `study-analytics` and `study-cell` is declared

#### Scenario: Unknown tab
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/studies/s1/runs`
- **THEN** the heading `Page not found` is shown

### Requirement: Problem page with tabs
THE problem page `case-detail` SHALL serve the tabs Overview, Runs, Versions, Source and Settings at `/app/:org/:project/problems/:case/:tab?`, showing the problem version named by the query `version`, or the latest problem version when the query names none.

`req~frontend-nav-problem-page~1`

Needs: impl, utest

Notes: design.md §11.14.

#### Scenario: Tabs of a member
- **GIVEN** a member of `acme` and the problem `routing` of `demo` with the versions 1, 2 and 3
- **WHEN** the person opens `/app/acme/demo/problems/routing`
- **THEN** the tabs read `Overview`, `Runs`, `Versions`, `Source`, `Settings`, and `Overview` is selected
- **AND** the version selector shows version 3

#### Scenario: A version chosen in the header
- **GIVEN** a member on `/app/acme/demo/problems/routing/source`
- **WHEN** the person chooses version 2 in the version selector
- **THEN** the address becomes `/app/acme/demo/problems/routing/source?version=2`
- **AND** the Source tab shows the compiled form of version 2 in a `SourceView` region

#### Scenario: Old problem version and compare addresses
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/cases/routing/revisions/2` and `/app/acme/demo/cases/routing/compare?from=1&to=3`
- **THEN** the addresses become `/app/acme/demo/problems/routing?version=2` and `/app/acme/demo/problems/routing/versions?from=1&to=3`
- **AND** the Versions tab compares version 1 with version 3

#### Scenario: Old snapshot address
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/snapshots/0b6c2f`
- **THEN** the address becomes `/app/acme/demo/problems`

#### Scenario: Tabs of a public visitor
- **GIVEN** a visitor reading the public project `demo` of `acme` (access `public_read`)
- **WHEN** the visitor opens `/app/acme/demo/problems/routing`
- **THEN** the tabs read `Overview`, `Versions`, `Source`

#### Scenario: Former problem screens are not routed
- **GIVEN** the route registry after the change
- **WHEN** the problems area test lists its screens
- **THEN** it lists `case-list`, `case-detail`, `wb-workbench` and `pub-workbench`
- **AND** none of `case-revision`, `case-compare` and `snap-detail` is declared

#### Scenario: Unknown tab
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/problems/routing/history`
- **THEN** the heading `Page not found` is shown

### Requirement: Public navigation
THE public header SHALL offer, in this order, the links Home, Explore, Engines, Language, Pricing, Verify and About, followed by Log in and Sign up while no person is signed in.

`req~frontend-nav-public-navigation~1`

Needs: impl, utest

Notes: design.md §11.15.

#### Scenario: Desktop header while signed out
- **GIVEN** a visitor without a session on `/pricing` at 1440×900
- **WHEN** the public header is rendered
- **THEN** its links read `Home`, `Explore`, `Engines`, `Language`, `Pricing`, `Verify`, `About`, `Log in`, `Sign up`
- **AND** their `href` values are `/`, `/explore`, `/engines`, `/language`, `/pricing`, `/verify`, `/about`, `/login` and `/register`
- **AND** `Pricing` carries `aria-current="page"`

#### Scenario: Phone menu
- **GIVEN** a visitor without a session on `/` at 390×844
- **WHEN** the visitor opens the header menu
- **THEN** it lists the same nine links in the same order

#### Scenario: Menus of the former header
- **GIVEN** a visitor without a session on `/`
- **WHEN** the public header is rendered
- **THEN** it has no link or menu named `Profiles & dialects`, `Schemas`, `Examples` or `Workbench`

### Requirement: Signed-in navigation
THE application header SHALL offer, in this order, Home, Problems, Lab with the entries Runs, Studies and Generator, Engines, Language and, for administrators only, Admin.

`req~frontend-nav-signed-in-navigation~1`

Needs: impl, utest

Notes: design.md §11.16.

#### Scenario: Header with a current project
- **GIVEN** a signed-in administrator with the project `demo` of `acme` current, on `/app/acme/demo/problems`
- **WHEN** the application header is rendered
- **THEN** its entries read `Home`, `Problems`, `Lab`, `Engines`, `Language`, `Admin`
- **AND** `Problems` leads to `/app/acme/demo/problems` and carries `aria-current="page"`
- **AND** the Lab menu lists `Runs` (`/app/runs`), `Studies` (`/app/acme/demo/studies`) and `Generator` (`/app/generator`)

#### Scenario: Header without a current project
- **GIVEN** a signed-in person with no current project, on `/app`
- **WHEN** the application header and its Lab menu are rendered
- **THEN** `Problems` and `Studies` are disabled (`aria-disabled="true"`, no `href`) with the hint `Needs a project`
- **AND** `Runs` and `Generator` keep their links

#### Scenario: A person who is not an administrator
- **GIVEN** a signed-in person whose role is `user`
- **WHEN** the application header is rendered
- **THEN** there is no entry `Admin`

#### Scenario: Former entries are gone
- **GIVEN** a signed-in administrator on `/app`
- **WHEN** the application header is rendered
- **THEN** it has no entry named `Jobs`, `Explore`, `Tools`, `Verifier` or `Engine catalog`

### Requirement: New menu
THE New menu of the application header SHALL offer exactly the items Problem, Collection, Study and Run, in this order, each leading into the current project, and disabled with the hint `Needs a project` when no project is current.

`req~frontend-nav-new-menu~1`

Needs: impl, utest

Notes: design.md §11.17.

#### Scenario: Items with a current project
- **GIVEN** a signed-in person with the project `demo` of `acme` current
- **WHEN** the person opens the New menu
- **THEN** its items read `Problem`, `Collection`, `Study`, `Run`
- **AND** they lead to `/app/acme/demo/problems?create=problem`, `/app/acme/demo/collections?create=collection`, `/app/acme/demo/studies/new` and `/app/acme/demo/runs/new`

#### Scenario: Items without a current project
- **GIVEN** a signed-in person with no current project
- **WHEN** the person opens the New menu
- **THEN** the four items are disabled with the hint `Needs a project`

#### Scenario: The problem dialog opens from the address
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/problems?create=problem`
- **THEN** the dialog `New problem` is open over the Problems tab

#### Scenario: Former items are gone
- **GIVEN** a signed-in person with a current project
- **WHEN** the person opens the New menu
- **THEN** it has no item `Organization`, `Project`, `Case`, `Job`, `API key` or `Engine`

### Requirement: Account menu
THE account menu of the application header SHALL offer, in this order, Profile, Plan, API keys, Identities and Notifications, followed by the sign-out action.

`req~frontend-nav-account-menu~1`

Needs: impl, utest

#### Scenario: Account menu entries
- **GIVEN** a signed-in person on `/app`
- **WHEN** the person opens the account menu
- **THEN** its links read `Profile`, `Plan`, `API keys`, `Identities`, `Notifications`
- **AND** their `href` values are `/app/account`, `/app/account/usage`, `/app/account/keys`, `/app/account/identities` and `/app/account/notifications`
- **AND** the last entry is the action `Sign out`

#### Scenario: Former labels are gone
- **GIVEN** a signed-in person on `/app`
- **WHEN** the person opens the account menu
- **THEN** no entry reads `Account` or `Plan & permissions`

### Requirement: Problem and Run vocabulary in the interface
THE frontend SHALL NOT show the whole words `case`, `cases`, `job` or `jobs`, nor, outside the engine-registration screens `eng-register`, `eng-registrations` and `eng-registration-detail`, `publication` or `publications`, in any letter case, in the visible text of a routed screen or of the application and public shells, outside `code` elements and `SourceView` and `LogPanel` regions.

`req~frontend-nav-vocabulary-text~1`

Needs: impl, utest

Notes: design.md §11.18.

#### Scenario: Route smoke
- **GIVEN** the mocked browser project and every routed screen of the registry, signed in where the screen needs it
- **WHEN** the route smoke opens each screen at 1440×900
- **THEN** no visible text outside `code` elements and `SourceView` and `LogPanel` regions holds `case`, `cases`, `job` or `jobs`
- **AND** no such text outside the three engine-registration screens holds `publication` or `publications`

#### Scenario: Engine publication to the catalogue
- **GIVEN** the engine registration detail with its section `Publication` and the action `Request publication`
- **WHEN** the route smoke opens `eng-registration-detail`
- **THEN** neither text is reported

#### Scenario: Kind names on Verify
- **GIVEN** a visitor without a session on `/verify?digest=sha256-1111111111111111111111111111111111111111111111111111111111111111`
- **WHEN** the kind selector is shown
- **THEN** the option for the kind `case-revision` reads `Problem version`

#### Scenario: A screen that still says Jobs
- **GIVEN** a screen whose heading reads `Jobs`
- **WHEN** the route smoke opens it
- **THEN** the smoke fails naming the screen id and the text `Jobs`

#### Scenario: A screen that still says Publications
- **GIVEN** the public home with the heading `Publications and public projects`
- **WHEN** the route smoke opens `pub-home`
- **THEN** the smoke fails naming `pub-home` and the text `Publications and public projects`

#### Scenario: API path as code
- **GIVEN** a screen that shows `/v1/organizations/acme/projects/demo/cases` inside a `code` element
- **WHEN** the route smoke opens it
- **THEN** the text is not reported

#### Scenario: Renamed labels
- **GIVEN** a member of `acme`
- **WHEN** the person opens `/app/acme/demo/problems` and `/app/acme/demo/runs`
- **THEN** the headings read `Problems` and `Runs`
- **AND** the Problems tab offers the action `New problem`

### Requirement: Problem and Run vocabulary in addresses
THE frontend SHALL address problems, runs and published results under the path segments `problems`, `runs` and `published`, with no routed path and no address built by the frontend outside `src/api/` holding a segment `cases`, `jobs` or `publications`.

`req~frontend-nav-vocabulary-urls~1`

Needs: impl, utest

Notes: design.md §11.19.

#### Scenario: Routed paths
- **GIVEN** the route registry after the change
- **WHEN** the registry test lists the paths of `routeDefinitions`
- **THEN** no path holds a segment `cases`, `jobs` or `publications`
- **AND** the paths include `/app/:org/:project/problems`, `/app/:org/:project/problems/:case/:tab?`, `/app/:org/:project/runs`, `/app/:org/:project/runs/new`, `/app/:org/:project/runs/:job`, `/app/runs` and `/app/:org/:project/published`

#### Scenario: Addresses in sources
- **GIVEN** the synthetic source `pages/X.tsx` holding ``` `${root}/cases/${slug}` ``` and `'/app/runs'`, and the synthetic source `src/api/cases.ts` holding ``` `${projectRoot(org, project)}/cases/${enc(caseSlug)}` ```
- **WHEN** the vocabulary address scan reads them
- **THEN** it returns exactly ``pages/X.tsx: ${root}/cases/${slug}``

#### Scenario: The API keeps its paths
- **GIVEN** a member of `acme` with a mocked gateway
- **WHEN** the person opens `/app/acme/demo/problems` and `/app/acme/demo/runs`
- **THEN** the frontend sends `GET` requests whose paths are `/v1/organizations/acme/projects/demo/cases` and `/v1/organizations/acme/projects/demo/jobs`, as before

#### Scenario: Old global runs address
- **GIVEN** a signed-in person
- **WHEN** the person opens `/app/jobs?state=running`
- **THEN** the address becomes `/app/runs?state=running`

### Requirement: Raw-rendering allow-list empty
THE raw-rendering allow-list SHALL hold no offender and no unlisted finding, with `MAX_ALLOWED_OFFENDERS` 0.

`req~frontend-nav-allow-list-empty~1`

Needs: impl, utest

Notes: design.md §11.20.

#### Scenario: Empty lists
- **GIVEN** the allow-list after the change
- **WHEN** the hygiene test reads it
- **THEN** `RAW_RENDERING_ALLOW_LIST` and `UNLISTED_FINDINGS` are empty and `MAX_ALLOWED_OFFENDERS` is 0
- **AND** `unlistedFindings`, `staleEntries` and `wrongLineNumbers` return empty lists for the application sources

#### Scenario: The workbench diff
- **GIVEN** the workbench with a changed file `application.yaml`
- **WHEN** the source panel shows its changes
- **THEN** the diff is in a `SourceView` region named `Changes to application.yaml` with a `Copy Changes to application.yaml` button
- **AND** `pages/Workbench/SourcePanel.tsx` renders no `<pre>` of its own

#### Scenario: A new raw block
- **GIVEN** the synthetic source `pages/X.tsx` rendering `<pre>{JSON.stringify(value)}</pre>`
- **WHEN** the hygiene test runs
- **THEN** it fails naming `pages/X.tsx` and the line
