# Tasks: m24-retire-screens-2

Slice 2 of M2.4 (report editor), one PR. Slice 1 is the change `m24-retire-screens`; slices 3–5 follow, each
specified when built. The slice extends `frontend/src/routes/retiredRoutes.tsx`, lowers the screen count and the
allow-list ceiling by what it removes, and leaves the gateway untouched. Tests carry
`[utest->req~frontend-retire-reports-<name>~1]`, code `[impl->…]` (design.md §6).

Checks the slice registers (frontend directory, frozen install first):
- `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run'` (registry, links, redirect, shell,
  hygiene and the touched pages);
- eslint and tsc of the frontend in the same `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec …'` form;
- the Playwright specs that the slice touches, through their registered check;
- `openspec validate m24-retire-screens-2 --strict` once the lab has the OpenSpec CLI; until then CI runs
  `openspec validate --strict --all`.

## S2. Report editor (tests first)

Tests first (they fail before 2.7–2.11):
- [ ] 2.1 `frontend/src/routes/retiredRoutes.test.tsx`: the scenarios of `reports-redirect` (list, report with query
  and hash, encoded slugs, history entry replaced, signed out first, targets routed to `proj-publications`, an artifact
  named `reports` keeps `lib-artifact`); the pure `target` with absent `org` or `project` gives `/app`; the slice-1
  cases that iterate over `RETIRED_ROUTES` with decision-space expectations are limited to `slice === 1` entries, and
  "every target is a routed screen" passes sample params to every entry (design.md §6).
- [ ] 2.2 `frontend/src/routes/routes.test.ts`: no `rep-list`/`rep-detail` id or path; D6 list of eight; 78 screens,
  D6 8 (`reports-screens-not-routed`, `reports-screen-count`); `/app/isa-demo/qos-benchmarks/publications` and
  `/app/verifier` still resolve (`reports-publications-stay`); `frontend/src/routes/retiredScreens.test.tsx`: 78
  screens and `MAX_ALLOWED_OFFENDERS` 13 instead of 80 and 14.
- [ ] 2.3 `frontend/src/routes/links.test.ts`: full and tail forms of `retiredAddresses` with synthetic controls,
  look-alikes, the `src/api/` exemption of the tail form, and the run on the application sources
  (`reports-no-link`).
- [ ] 2.4 `components/PlatformShell/SectionNav.test.tsx` (tabs of a member and of a public visitor, `Publications`
  current on the publications screen) and `paletteCommands.test.ts` (`Publications`, no `Reports`)
  (`reports-navigation`); `appNavigation.test.ts` drops `reports` from its section list.
- [ ] 2.5 `frontend/src/test/rawRenderingHygiene.test.ts`: offenders 1–4, 6, 8–15, ceiling 13, unlisted 16 only
  (`reports-allow-list`).
- [ ] 2.6 Page tests asserting absence: `pages/Jobs/JobDetail.test.tsx` (no `Add to a report`),
  `pages/Studies/StudyRun.test.tsx` and `StudyAnalytics.test.tsx` (no `Create a report`/`Open the report`, no reports
  request), `pages/Project/ProjectOverview.test.tsx` and `projectModel.test.ts` (no `Reports` region, `All reports`,
  `New report`; section list with `publications`) (`reports-entry-points-removed`);
  `pages/Reports/ProjPublications.test.tsx`, `Verifier.test.tsx`, `pages/Platform/InspectionPages.test.tsx`
  (`<base>/publications`), `pages/Resolve/Resolve.test.tsx` (`Open in platform` of a report at `<base>/publications`)
  (`reports-publications-stay`, `reports-no-link`).

Source:
- [ ] 2.7 `frontend/src/routes/retiredRoutes.tsx`: `target(query, params)`, the two entries `rep-list` and
  `rep-detail` with `slice: 2` and one `publicationsTarget`; `frontend/src/routes/index.tsx`: `RetiredRedirect` passes
  `useParams()`, the retired routes mounted after the screens (design.md §2).
- [ ] 2.8 `frontend/src/routes/d6.tsx`: drop `rep-list` and `rep-detail` and their lazy imports; header comment "8
  screens".
- [ ] 2.9 Delete `frontend/src/pages/Reports/{RepList,RepDetail,NewReport,PublishDialog,ReportBlocks,SavedDecision}.tsx`,
  `SavedDecision.css`, `RepList.test.tsx`, `RepDetail.test.tsx`, `SavedDecision.test.tsx`, and
  `frontend/src/pages/Studies/reportActions.ts`; trim `reportsModel.ts`, `reportErrors.ts` and
  `frontend/src/analysis/archive.ts` (`decisionReceipt`) to what non-test code still imports, with their tests
  (design.md §1); check `Reports.css` for rules only the deleted pages used.
- [ ] 2.10 Links of design.md §3: `ProjectTabs.tsx` (`ProjectSection`), `pages/Reports/parts.tsx`
  (`active="publications"`, crumb comment), `paletteCommands.ts`, `ProjectOverview.tsx`, `JobDetail.tsx`,
  `StudyRun.tsx`, `StudyAnalytics.tsx`, `ProjPublications.tsx` (with its empty-state sentence), `pages/Platform/verifierOptions.ts`,
  `pages/Resolve/resolveModel.ts`.
- [ ] 2.11 `frontend/src/test/rawRenderingAllowList.ts`: remove offender 5; `MAX_ALLOWED_OFFENDERS` 13.

End to end:
- [ ] 2.12 Playwright: `e2e/s7b-reports.spec.ts` drops the `rep-list` and `rep-detail` tests and its `Open the report`
  expectation, expects the verifier's `Open` at `<root>/publications`, and adds one smoke step: the old link
  `/app/isa-demo/qos-benchmarks/reports/engine-comparison` lands on `/app/isa-demo/qos-benchmarks/publications`;
  `e2e/s6a-jobs.spec.ts` (no `Add to a report`), `e2e/s7a-studies.spec.ts` (no `Open the report`),
  `e2e/s4b-project.spec.ts` (no `Reports` region or `New report`, public tabs with `Publications`),
  `e2e/qa-gallery.spec.ts` and `e2e/helpers/galleryRoutes.ts` (78 screens, no `rep-list`/`rep-detail`),
  `e2e/responsive.spec.ts` (comment naming the tabs).

Guide and review:
- [ ] 2.13 `docs/agent-work/m24-retire-screens-2/review/how-to-test.md`: old report addresses redirect, the
  `Publications` tab and command, the publications list without report links, the removed entry points; before and
  after captures as available.
- [ ] 2.14 Confirm the diff touches nothing under `openbinding-gateway/`, `engines/` or `docs/openapi.json`
  (`req~frontend-retire-gateway-untouched~1`; a review check of the PR diff, no test).
- [ ] 2.15 Review sign-off of the PR (G11).
- Acceptance: the frontend suite, eslint and tsc pass; every scenario of the eight requirements has a test.

## Slices 3–5 (next)

Each is specified when built, in its own change on the model of this one.
- S3. Library catalogue and project resources: `lib-list`, `lib-artifact`, `lib-draft`, `lib-version`,
  `proj-library`, `proj-resources`, `proj-resource-detail`; offender 11 (`pages/Library/ContentView.tsx`). Specified
  when built.
- S4. Composer: `case-composer`. Specified when built.
- S5. Sponsorship: `admin-sponsor`, the page `AdminSponsor` and its usage hook. Specified when built.

## Archive (later)
- [ ] Archive (separate, explicit archive task, after S5, together with `m24-retire-screens`):
  `["openspec", "archive", "m24-retire-screens-2", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- Owner CRP: `Deprecation` and `Sunset` headers on the report endpoints, then their removal with the frontend API
  client's report functions, and the export and drop of report drafts (ROADMAP M2.4, M9.6).
- Archive of `m24-retire-screens`: the slice-1 scenarios with values that slice 2 changed (D6 list with `rep-list` and
  `rep-detail`, 80 screens and D6 10, offenders 1–6 and 8–15 with ceiling 14) are reconciled before or during the
  archive, and the statement of `req~frontend-retire-redirect-generic~1` ("computes from the query", every address of
  a retired path) gets a new revision that covers path params and the `lib-artifact` exception (design.md §6).
- Archive of `m21-rendering-catalogue`: its scenario "Today's offenders are listed" (15, exactly 1–15) already no
  longer held after slice 1.
- The "Publish" of a study run or a collection version (ADR-0020 decision 2): a later milestone.
