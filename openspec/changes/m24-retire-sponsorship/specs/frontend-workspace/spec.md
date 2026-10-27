## ADDED Requirements

### Requirement: Sponsorship address redirects to the administration overview
WHEN a person opens an address that matches `/app/admin/organizations/:org/sponsor`, THE frontend SHALL replace the current history entry with `/app/admin`, with no query and no hash, whatever the organization of the opened address.

`req~frontend-retire-sponsorship-redirect~1`

Needs: impl, utest

Evidence: `frontend/src/routes/retiredRoutes.test.tsx`; `frontend/src/routes/retiredScreens.test.tsx`; `frontend/src/routes/retiredRoutes.tsx`; `frontend/src/routes/index.tsx`

The path is the entry of slice 5 (`slice: 5`) in `frontend/src/routes/retiredRoutes.tsx`, appended after the slice-4
entry. The redirect sits behind the client-side guard and keeps `state.from`, as for slices 1 to 4; the target keeps
its administrator guard, so a signed-in person without the administrator role ends at `/app/account`, as before. The
retired routes stay mounted after the screens. No route ties with the path: it outranks every screen and retired route
that matches the same address, such as `case-detail` for `/app/admin/organizations/cases/sponsor` and `rep-detail`
for `/app/admin/organizations/reports/sponsor` (design.md §2).

#### Scenario: The sponsorship of an organization
- **GIVEN** a signed-in administrator on `/app/admin/users/00000000-0000-4000-8000-000000000002`
- **WHEN** the person follows a link to `/app/admin/organizations/isa-demo/sponsor` and then goes back once
- **THEN** the address after the redirect is `/app/admin`
- **AND** going back shows `/app/admin/users/00000000-0000-4000-8000-000000000002`, not the sponsorship address

#### Scenario: A sponsorship address with a query and a hash
- **GIVEN** a signed-in administrator
- **WHEN** the person opens `/app/admin/organizations/isa-demo/sponsor?tab=requests#limits`
- **THEN** the address becomes `/app/admin` with no query and no hash

#### Scenario: An organization named by id or with encoded characters
- **GIVEN** a signed-in administrator
- **WHEN** the person opens `/app/admin/organizations/00000000-0000-4000-8000-000000000950/sponsor` and `/app/admin/organizations/isa%20demo/sponsor`
- **THEN** both addresses become `/app/admin`

#### Scenario: Signed out first
- **GIVEN** no session
- **WHEN** the visitor opens `/app/admin/organizations/isa-demo/sponsor` and signs in as an administrator
- **THEN** the frontend shows `/login` first, with `state.from` naming the opened address, and then `/app/admin`

#### Scenario: A person without the administrator role
- **GIVEN** a signed-in person whose role is `user`
- **WHEN** the person opens `/app/admin/organizations/isa-demo/sponsor`
- **THEN** the address becomes `/app/account`
- **AND** no administration screen is rendered

#### Scenario: Neighbouring administration screens keep their addresses
- **GIVEN** a signed-in administrator
- **WHEN** the person opens `/app/admin`, `/app/admin/users/00000000-0000-4000-8000-000000000002` and `/app/organizations/new`
- **THEN** the three addresses stay and resolve to the screens `admin-overview`, `admin-user-detail` and `org-create`

#### Scenario: Addresses that other routes also match
- **GIVEN** a signed-in administrator
- **WHEN** the person opens `/app/admin/organizations/cases/sponsor` and `/app/admin/organizations/reports/sponsor`
- **THEN** both addresses become `/app/admin`

#### Scenario: The target is a routed screen
- **GIVEN** the slice-5 entry of `RETIRED_ROUTES`, the query `tab=requests` and the params `org=a`
- **WHEN** the target is computed and its path is matched against `routeDefinitions`
- **THEN** the target is `/app/admin`
- **AND** its path resolves to `admin-overview`

### Requirement: Sponsorship screen is not routed
THE route registry SHALL declare neither the screen id `admin-sponsor` nor the path `/app/admin/organizations/:org/sponsor`.

`req~frontend-retire-sponsorship-screen-not-routed~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`; `frontend/src/routes/retiredScreens.test.tsx`; `frontend/src/routes/d8.tsx`

The page `pages/Admin/AdminSponsor.tsx` is deleted with its test and the styles only it and the removed controls used
(design.md §1). The ids and paths of slices 1 to 4 stay absent.

#### Scenario: Slice 5 id is gone
- **GIVEN** the route registry after slice 5
- **WHEN** the registry test lists the ids of `routeDefinitions`
- **THEN** `admin-sponsor` is not among them
- **AND** none of `analysis-sources`, `analysis-workspace`, `rep-list`, `rep-detail`, `lib-list`, `lib-artifact`, `lib-draft`, `lib-version`, `proj-library`, `proj-resources`, `proj-resource-detail`, `case-composer` is among them

#### Scenario: Slice 5 path is gone
- **GIVEN** the route registry after slice 5
- **WHEN** the registry test lists the paths of `routeDefinitions`
- **THEN** no path ends with `/sponsor` and no path starts with `/app/admin/organizations`
- **AND** the D8 list of the registry test reads `admin-overview`, `admin-users`, `admin-user-detail`, `admin-audit`, `admin-errors`, `admin-queues`, `admin-moderation`, `admin-maintenance`

#### Scenario: Every administration screen still needs an administrator
- **GIVEN** the route registry after slice 5
- **WHEN** the registry test lists the screens whose id starts with `admin-`
- **THEN** it lists 8 screens, each with `requireAdmin` and a path under `/app/admin`
- **AND** no other screen has `requireAdmin`

#### Scenario: No screen file is left
- **GIVEN** the sources after slice 5
- **WHEN** the test lists the files that match `pages/Admin/AdminSponsor*`
- **THEN** it lists none

### Requirement: No link leads to the sponsorship address
IF a source file under `frontend/src`, other than a test file, a file under `src/test/` and `routes/retiredRoutes.tsx`, holds a string or template literal that starts with `/app/admin/organizations/:org/sponsor`, or, in a file not under `src/api/`, a template literal in which a `${…}` is directly followed by `/sponsor`, the parameter standing for one segment or one `${…}` and the match followed by the end of the literal, `/`, `?`, `#` or `${`, THEN the frontend test suite SHALL fail naming the file and the literal.

`req~frontend-retire-sponsorship-no-link~1`

Needs: impl, utest

Evidence: `frontend/src/routes/links.test.ts`

The scan is the slice-2 one applied to the slice-5 entry. The gateway endpoint `/v1/admin/organizations/${…}/sponsor`
of `src/api/client.ts` is not an address of the application and matches neither form (design.md §4).

#### Scenario: Full address and tail are reported
- **GIVEN** the slice-5 path and the synthetic source `pages/X.tsx` holding ``const a = `/app/admin/organizations/${encodeURIComponent(value)}/sponsor`;``, `const b = '/app/admin/organizations/isa-demo/sponsor?tab=requests';` and ``const c = `${base}/sponsor`;``
- **WHEN** the link scan reads it
- **THEN** it returns exactly ``pages/X.tsx: /app/admin/organizations/${encodeURIComponent(value)}/sponsor``, `pages/X.tsx: /app/admin/organizations/isa-demo/sponsor?tab=requests` and ``pages/X.tsx: ${base}/sponsor``

#### Scenario: Look-alikes, endpoints and replacements are not reported
- **GIVEN** the slice-5 path and the synthetic source `pages/Z.tsx` holding `'/app/admin/organizations/isa-demo/sponsors'`, ``` `${base}/sponsor-proposals` ```, ``` `/v1/admin/organizations/${id}/sponsor` ```, `'/app/admin'` and `'/app/admin/users/u1'`
- **WHEN** the link scan reads it
- **THEN** it returns an empty list

#### Scenario: The application sources hold no sponsorship address
- **GIVEN** the application sources after slice 5
- **WHEN** the link scan reads them with the paths of `RETIRED_ROUTES`
- **THEN** it returns an empty list
- **AND** the slice-5 entries of `RETIRED_ROUTES` are exactly one, with the path `/app/admin/organizations/:org/sponsor`

### Requirement: Administration screens offer no way to the sponsorship screen
THE administration overview and the administration account detail SHALL offer no control that leads to the sponsorship address and no text that names a sponsorship screen.

`req~frontend-retire-sponsorship-entry-points-removed~1`

Needs: impl, utest

Evidence: `frontend/src/pages/Admin/AdminOverview.test.tsx`; `frontend/src/pages/Admin/AdminUserDetail.test.tsx`

The controls are removed, not repointed, because the retired screen was their only function: the `Sponsorship
transfer` tool of the overview (field `Organization slug or id`, button `Open`) and the `Organizations` card of the
account detail (field `Organization slug or id`, button `Open sponsorship`). The overview's lede no longer names
sponsorship. Texts that describe sponsor events (audit log) or sponsored limits (account agreement) stay, and so do the
organization-level sponsor screens (design.md §3).

#### Scenario: Overview tools
- **GIVEN** an administrator on `/app/admin`
- **WHEN** the screen is rendered
- **THEN** the section `Tools` holds exactly the links `Accounts`, `Account agreement`, `Audit log`, `Errors`, `Queues`, `Moderation` and `Maintenance`, with the `href` values `/app/admin/users`, `/app/admin/users`, `/app/admin/audit`, `/app/admin/errors`, `/app/admin/queues`, `/app/admin/moderation` and `/app/admin/maintenance`
- **AND** the section has no form, no field `Organization slug or id`, no button `Open` and no text `Sponsorship transfer`

#### Scenario: Overview lede
- **GIVEN** an administrator on `/app/admin`
- **WHEN** the screen is rendered
- **THEN** the lede reads `How the platform is doing, and where to act. Contract, pricing and maintenance changes are recorded in the audit log.`
- **AND** no text of the screen contains `sponsorship`

#### Scenario: Account detail
- **GIVEN** an administrator on `/app/admin/users/00000000-0000-4000-8000-000000000002`
- **WHEN** the screen is rendered
- **THEN** there is no heading `Organizations`, no field `Organization slug or id` and no button `Open sponsorship`
- **AND** no text contains `billing sponsorship`
- **AND** the field `Key id` and the button `Revoke key` are still shown

### Requirement: Screen count after sponsorship
THE route registry SHALL hold 69 screens, with 8 in domain D8.

`req~frontend-retire-sponsorship-screen-count~1`

Needs: impl, utest

Evidence: `frontend/src/routes/routes.test.ts`; `frontend/src/routes/retiredScreens.test.tsx`

70 after slice 4, 69 after slice 5. The other domains keep their counts; redirect entries are not screens.

#### Scenario: Slice 5 count
- **GIVEN** the route registry after slice 5
- **WHEN** the registry test counts `routeDefinitions`
- **THEN** it counts 69 screens
- **AND** the domain sizes read D1 18, D2 7, D3 10, D4 10, D5 4, D6 8, D7 4 and D8 8

#### Scenario: A screen left behind
- **GIVEN** a registry that still declares `admin-sponsor` at `/app/admin/organizations/:org/sponsor`
- **WHEN** the registry test runs
- **THEN** it fails, counting 70 screens instead of 69
