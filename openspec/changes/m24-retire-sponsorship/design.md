# Design: m24-retire-sponsorship

Status: slice 5 of M2.4 (sponsorship), the last slice. The shared rules are in `m24-retire-screens` (slice 1),
`m24-retire-screens-2` (slice 2: path params, link scan tail form, retired routes mounted after the screens),
`m24-retire-screens-3` (slice 3: entry order and ties among retired routes) and `m24-retire-composer` (slice 4), all
merged and not archived. Fixed inputs: ROADMAP M2.4, ADR-0020 decisions 2, 3 and 5, INTENT D3 and D8, the registry
after slice 4 (70 screens, D8 9), the allow-list after slice 4 (12 offenders, unlisted finding 16).

## 1. Context

One screen of domain D8 (`frontend/src/routes/d8.tsx`, every screen `requireAdmin`) goes:

| Id | Path | Page |
|---|---|---|
| `admin-sponsor` | `/app/admin/organizations/:org/sponsor` | `pages/Admin/AdminSponsor.tsx` |

`AdminSponsor.tsx` and `AdminSponsor.test.tsx` are deleted, with the rules of `pages/Admin/AdminScreens.css` that only
the screen and the two removed controls (§3) use: the `Sponsorship` block (`.adm-org`, `.adm-org > strong`, `.adm-tree`
and its `ul` and `li span` rules, `.adm-candidates`), `.adm-two` (its rule, and its selector in the
`max-width: 900px` media rule, which keeps `.adm-split`), the overview's form tool `.adm-tool.is-form` (the
`min-width: 900px` media rule) and `.adm-tool-row` with its `label` and `input` rules; the header comment drops
"sponsorship". `.adm-card .adm-search` is a candidate too: today only the sponsorship screen puts a search inside a
card. The build checks this list again: what another non-test file still uses stays (`.adm-choice` in
`AdminAgreement.tsx`, `.adm-inline-form` and `.adm-field` in the key form of `AdminUserDetail.tsx`, `.adm-search` in
`AdminUsers.tsx`, `.adm-buttons`, `.adm-card-head`).

No helper goes: every other import of the page has another non-test importer. `SponsorRequestCard` (`SponsorCards.tsx`),
`pendingOf` and `sponsorRefusal` (`sponsorModel.ts`) are used by `OrgSettings.tsx`; `planTone` by `AdminUsers.tsx`;
`UUID` by `AdminAudit.tsx`, `AdminErrors.tsx` and `AdminUserDetail.tsx`; `limitInfo` and `describeLimit` by
`AdminAgreement.tsx` and others; `isSponsorProposal` by `OrgSettings.tsx`. After the slice
`apiClient.adminTransferSponsor` has no caller left; it stays with the endpoint (decision 5, M9.6). Test fixtures of
`src/test/fixtures/admin.ts` stay unless only `AdminSponsor.test.tsx` used them.

The replacement is the administration overview `admin-overview` (`/app/admin`): it is where an administrator lands,
links every administration screen, and opens the SPACE console where plans are assigned. Slice 5 does not change it
beyond removing the sponsorship tool (§3).

## 2. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Target | `/app/admin`, fixed: the organization (`:org`), the query and the hash are dropped | the organization settings `/app/<org>/settings`, whose change-sponsor section stays: `:org` may be an id, which that address does not read, and an administrator who is not a member cannot open it; the account detail of the sponsor: the old address names no account |
| Table entry | `{ id: 'admin-sponsor', path: '/app/admin/organizations/:org/sponsor', slice: 5, target: administrationTarget }` appended after the slice-4 entry; mounted after the screens like the others, behind the signed-in guard, keeping `state.from` | a place earlier in the table: changes nothing (no tie, below), but breaks the slice order |
| Guard | the redirect is behind the signed-in guard only, like every retired route; `/app/admin` keeps its administrator guard, so a signed-in person without the administrator role ends at `/app/account`, where the screen sent them before (two hops instead of one, both replacing the history entry) | an administrator guard on the redirect: one route of the table with its own rule, for the same end address |
| Ties | No tie. The path has four static segments and one dynamic one; React Router ranks it above every other route that matches the same addresses, all with at most three static segments: the screens `case-detail`, `study-detail`, `job-detail`, `snap-detail`, `coll-detail` (an organization `admin`, a project `organizations`, a section slug in place of `:org`, an item `sponsor`, as in `/app/admin/organizations/cases/sponsor`) and the retired `rep-detail` and `proj-resource-detail` (`/reports/sponsor`, `/resources/sponsor`). These addresses open `/app/admin`, as the screen took them before; the organization `admin` cannot open `/app/admin` today either (the frontend's `RESERVED_SLUGS` lists `admin`; the gateway does not reserve it). No other address changes its route | a reserved organization slug `admin` in the gateway: a data rule for a routing problem, outside this frontend slice |
| Controls | the `Sponsorship transfer` tool of the overview and the `Organizations` card of the account detail are removed (§3), not repointed | repointing them to the organization settings: they take an id or a slug the settings do not read, and the settings are not an administrator's screen |
| Texts | reworded so no administration screen promises the retired screen (§3); texts that describe sponsor events or sponsored limits stay | removing every mention of sponsors: the audit log still records the organization-level sponsor flow, which stays |
| Allow-list | unchanged: the sponsorship screen is no offender of `RAW_RENDERING_ALLOW_LIST`; `MAX_ALLOWED_OFFENDERS` stays 12 and needs no requirement | — |
| API client | `api/client.ts` (`adminTransferSponsor`, `listOrganizationSponsorProposals`, `cancelSponsorProposal`, `adminGetUserUsage`, `adminGetSubscription`) and `api/auth.ts` untouched; gateway, engines and `docs/openapi.json` untouched; no `Deprecation`/`Sunset` (owner CRP, M9.6) | removing `adminTransferSponsor` now: decision 5 retires code after the endpoints |

## 3. Links and texts of slice 5

| Where | Today | After |
|---|---|---|
| `pages/Admin/AdminOverview.tsx`, Tools grid | `SponsorshipTool`: form `Sponsorship transfer` ("Move an organization’s billing sponsor after a quota check."), field `Organization slug or id`, button `Open`, navigating to `/app/admin/organizations/<value>/sponsor` | removed; the grid holds the seven links `Accounts`, `Account agreement`, `Audit log`, `Errors`, `Queues`, `Moderation`, `Maintenance` |
| `pages/Admin/AdminOverview.tsx`, lede | "How the platform is doing, and where to act. Contract, pricing, sponsorship and maintenance changes are recorded in the audit log." | "How the platform is doing, and where to act. Contract, pricing and maintenance changes are recorded in the audit log." |
| `pages/Admin/AdminOverview.tsx`, doc comment of `AdminOverview` | "… a way into every administration screen, and the tools that don’t have one yet." | "… and a way into every administration screen." |
| `pages/Admin/AdminUserDetail.tsx` | `OrganizationsCard`: heading `Organizations`, "Not listed by the gateway", "… If you know the organization, you can open its billing sponsorship, where an account can be set as sponsor.", field `Organization slug or id`, button `Open sponsorship`, navigating to `/app/admin/organizations/<value>/sponsor` | removed; the account detail keeps its other cards, including the key form (`Key id`, `Revoke key`) |

Searched and kept, because they do not lead to or promise the retired screen: the lede of `AdminAudit.tsx` ("Events
recorded inside an organization, such as a sponsor request, appear here too …") and the sponsor event texts of
`adminModel.ts` (the organization-level flow and the endpoint still record them); the sponsored limits of
`AdminAgreement.tsx` (pricing; ADR-0020 consequences); "Transfer sponsorship first." of `pages/Account/ProfileForms.tsx` (account
deletion; the owner transfers in the organization settings, which stay); the administrator note of `OrgCreate.tsx`.
`AdminChrome.tsx` (administration navigation) and `components/PlatformShell/paletteCommands.ts` name no sponsorship
screen and do not change.

## 4. Link scan

Unchanged rules of slices 2 to 4; the slice-5 entry adds the full form `/app/admin/organizations/:org/sponsor` and the
tail form `${…}/sponsor` (the static tail after `:org`). The three literals that build the address today are full
forms (`AdminSponsor.tsx`, `AdminOverview.tsx`, `AdminUserDetail.tsx`) and go with §1 and §3. The gateway endpoint
`/v1/admin/organizations/${…}/sponsor` of `api/client.ts` matches neither form (it starts with `/v1`, and `src/api/` is
exempt from the tail form); `${…}/sponsor-proposals` is no finding (`-` does not end a path).

## 5. Allow-list

Unchanged: offenders 1–4, 6, 8–10, 12–15, ceiling 12, unlisted finding 16. The slice-1 rule (`ceilingMismatch`) keeps
holding with no edit.

## 6. Requirements, tests and earlier scenarios

| Requirement | Tests |
|---|---|
| `frontend-retire-sponsorship-redirect` | `routes/retiredRoutes.test.tsx`, `routes/retiredScreens.test.tsx` |
| `frontend-retire-sponsorship-screen-not-routed`, `-screen-count` | `routes/routes.test.ts`, `routes/retiredScreens.test.tsx` |
| `frontend-retire-sponsorship-no-link` | `routes/links.test.ts` |
| `frontend-retire-sponsorship-entry-points-removed` | `pages/Admin/AdminOverview.test.tsx`, `pages/Admin/AdminUserDetail.test.tsx` |

Tests carry `[utest->req~frontend-retire-sponsorship-<name>~1]`; `retiredRoutes.tsx`, `index.tsx` (redirect component),
`d8.tsx`, `AdminOverview.tsx` and `AdminUserDetail.tsx` carry `[impl->…]`.

Values of earlier changes that slice 5 changes, reconciled at the archive: slice 4's 70 screens and D8 9
(`req~frontend-retire-composer-screen-count~1`), the D8 9 of the domain sizes of slices 1 to 3, and slice 1's scenario
naming the slices still to come. Slice-1/2/3/4 tests that iterate over `RETIRED_ROUTES` stay limited to their own
`slice`, or gain a slice-5 row where they cover every entry (the "every target is a routed screen" case of
`retiredRoutes.test.tsx`: `admin-overview`, `/app/admin`); `retiredScreens.test.tsx` moves to 69 and 12, and
`routes.test.ts` to 69 screens, D8 8 and eight administrator screens.

## 7. Risks

- Administrators lose the screen to move an organization's billing sponsor: naming themselves (an immediate change),
  sending a request to another account, replacing or cancelling a pending request, and the new sponsor's limits in view.
  The endpoint `POST /v1/admin/organizations/{id}/sponsor` and `/v1/sponsor-proposals/{id}/cancel` stay for API use
  until the owner CRP (M9.6). Accepted: this is the retirement decided in ADR-0020 (decision 2) and INTENT D3; plans
  are per-account SPACE contracts assigned by agreement.
- An organization owner keeps the change-sponsor section of the organization settings; an administrator who is not a
  member of the organization has no screen left for it.
- An old sponsorship link opens the administration overview, not the organization; the organization is dropped.
- A signed-in person without the administrator role who opens the old address goes through two redirects to
  `/app/account`, where the screen's guard sent them before.
- The account detail loses its `Organizations` card; its only action opened the retired screen.
- The slice deletes more lines than it adds; added or changed lines stay at about 300 or fewer (constitution 14.1).

## 8. Rollback

Reverting the PR restores the screen, its page, test and styles, the overview tool, the account detail card and the
overview lede, 70 screens and D8 9. No data or API is touched.
