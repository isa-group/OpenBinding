# Tasks: m24-retire-sponsorship

Slice 5 of M2.4 (sponsorship), the last slice, one PR. Tests carry `[utest->req~frontend-retire-sponsorship-<name>~1]`,
code `[impl->…]` (design.md §6). Diff budget: the PR adds or changes about 300 lines or fewer; deletions (the page, its
test, the styles and the removed controls) do not count against it (constitution 14.1).

Checks the slice registers (frontend directory, frozen install first): vitest, eslint and tsc in the
`bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec …'` form; the touched Playwright specs;
`openspec validate m24-retire-sponsorship --strict` once the lab has the CLI (until then CI runs
`openspec validate --strict --all`).

## S5. Sponsorship (tests first)

Tests first:
- [ ] 5.1 `routes/retiredRoutes.test.tsx`: the `sponsorship-redirect` scenarios (target `/app/admin` whatever the
  organization, query and hash dropped, history replaced, signed out first with `state.from`, a person without the
  administrator role ending at `/app/account`, neighbouring administration screens kept, the addresses that
  `case-detail` and `rep-detail` also match); a slice-5 row in the "every target is a routed screen" case
  (`admin-overview`, `/app/admin`); the slice-5 entry is the only one and comes after the slice-4 entry; slice-1/2/3/4
  cases limited to their `slice`. `renderAt` gains an administrator variant (`isAdmin: true`) and a stub of
  `pages/Admin/AdminOverview`.
- [ ] 5.2 `routes/routes.test.ts`: id and path gone (the `resolve` of the sponsorship address removed), D8 list of
  eight, 69 screens, D8 8, eight administrator screens; `retiredScreens.test.tsx`: a slice-5 block (registry, no
  `pages/Admin/AdminSponsor*` file, the redirect for an administrator and for a person without the role), 69 and 12.
- [ ] 5.3 `routes/links.test.ts`: slice-5 full and tail forms, look-alikes, the gateway endpoint and the replacements,
  application sources, one slice-5 entry.
- [ ] 5.4 Page tests (`sponsorship-entry-points-removed`): `pages/Admin/AdminOverview.test.tsx` (the seven tools,
  no form, field or `Open` button, the new lede); `pages/Admin/AdminUserDetail.test.tsx` (the case "offers the
  sponsorship screen" becomes: no `Organizations` card, no `Open sponsorship`, the key form still shown).

Source:
- [ ] 5.5 `routes/retiredRoutes.tsx`: `administrationTarget` (always `/app/admin`) and the entry `admin-sponsor` with
  `slice: 5` after the slice-4 entry (design.md §2); the table comment names the slice; `index.tsx` gains the
  `[impl->req~frontend-retire-sponsorship-redirect~1]` tag on `RetiredRedirect`, with no code change.
- [ ] 5.6 `routes/d8.tsx`: drop `admin-sponsor` and its lazy import; header "8 screens".
- [ ] 5.7 Delete `pages/Admin/AdminSponsor.tsx` and `AdminSponsor.test.tsx`; remove the rules of `AdminScreens.css`
  of design.md §1 and its header mention; test fixtures only the deleted test used.
- [ ] 5.8 Controls and texts of design.md §3: `pages/Admin/AdminOverview.tsx` (`SponsorshipTool` and its call, the
  lede, the doc comment, the imports left unused); `pages/Admin/AdminUserDetail.tsx` (`OrganizationsCard` and its call,
  the imports left unused).
- [ ] 5.9 Confirm by search that no other screen promises the retired screen (design.md §3: `AdminAudit.tsx`,
  `AdminAgreement.tsx`, `adminModel.ts`, `AdminChrome.tsx`, `paletteCommands.ts`, `ProfileForms.tsx` stay as they are).

Outside `frontend/src`:
- [ ] 5.10 Playwright: `e2e/s9a-admin.spec.ts` drops the `admin-sponsor` test (lines ~685–774), the header mention of
  `admin-sponsor` and the mock handlers only that test used (`state.sent.sponsor`, `state.refuse.sponsor`,
  `state.refuse.organization`, the sponsor and cancel routes, if nothing else reads them); the admin-overview test
  (lines ~341–345) asserts that the Tools hold no `Organization slug or id` field and gains the redirect smoke
  `/app/admin/organizations/isa-demo/sponsor` → `/app/admin` (heading `Administration`); the non-administrator test
  (line ~779) keeps the sponsorship address in its list, now ending at `/app/account` through the redirect;
  `e2e/qa-gallery.spec.ts` (without the `admin-sponsor` expectation) and `e2e/routes-smoke.spec.ts` at 69 screens;
  `e2e/helpers/galleryRoutes.ts` drops its `admin-sponsor` entry.
- [ ] 5.11 `ROADMAP.md`: the M2 row and the M2.4 "Slice status" paragraph record slice 4 merged (PR #65) and slice 5
  (never the `Status: PROPOSED` lines).
- [ ] 5.12 `docs/agent-work/m24-retire-sponsorship/review/how-to-test.md` from `how-to-test.md` of this change, with
  the results of the preview.
- [ ] 5.13 Confirm the diff touches no gateway source or test, engine, worker, `docs/openapi.json` or `api/*.ts`
  function (`adminTransferSponsor` stays), and that `MAX_ALLOWED_OFFENDERS` stays 12.
- [ ] 5.14 Review sign-off (G11).
- Acceptance: frontend suite, eslint, tsc and the touched Playwright specs pass; every scenario of the five requirements
  has a test.

## Archive (later)
- [ ] Archive in an explicit archive task after this slice, with `m24-retire-screens`, `m24-retire-screens-2`,
  `m24-retire-screens-3` and `m24-retire-composer`: `["openspec", "archive", "m24-retire-sponsorship", "--yes"]`, then
  `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- Reconcile at the archive the earlier scenarios slice 5 changes: slice 4's 70 screens and D8 9
  (`req~frontend-retire-composer-screen-count~1`), the D8 9 of the domain sizes of slices 1 to 3, slice 1's scenario
  naming the slices to come (design.md §6).
- Owner decision: whether the organization-level sponsor flow retires too (INTENT §6 "Organization sponsorship:
  retire", D3): the change-sponsor section of `OrgSettings.tsx`, `SponsorCards.tsx`, `sponsorModel.ts`, the sponsor step
  of `OrgCreate.tsx`, `SponsorRequestsForYou.tsx`, the sponsor requests of the notification dropdown, and
  `useSponsorUsage.ts` (still imported by `CollList.tsx` and `ProjFiles.tsx`). These are other screens, kept by this
  slice.
- Owner CRP: `Deprecation` and `Sunset` on the retired endpoints, including `POST /v1/admin/organizations/{id}/sponsor`,
  then their removal with `apiClient.adminTransferSponsor` and the sponsorship proposals data (M2.4, M9.6); the
  sponsorship capacity checks (M4.3).
