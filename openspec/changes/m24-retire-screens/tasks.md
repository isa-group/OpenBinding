# Tasks: m24-retire-screens

M2.4 is delivered in five sequential PRs, one screen group each: S1 decision-space workspace, S2 report editor, S3
library catalogue and project resources, S4 composer, S5 sponsorship. Only S1 is specified in this PR; S2–S5 are
follow-up slices (not done), each specified in this change before it is built. Every slice extends
`frontend/src/routes/retiredRoutes.tsx`, lowers the screen count and the allow-list ceiling by what it removes, and
leaves the gateway untouched. Tests carry `[utest->req~frontend-retire-<name>~1]`, code `[impl->…]` (design.md §7).

Checks each slice registers (frontend directory, frozen install first):
- `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run'` (registry, links, redirect, shell,
  hygiene and the touched pages);
- eslint and tsc of the frontend in the same `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec …'` form;
- the Playwright specs that the slice touches, through their registered check;
- `openspec validate m24-retire-screens --strict` once the lab has the OpenSpec CLI; until then CI runs
  `openspec validate --strict --all`.

## S1. Decision-space workspace (this PR; tests first)
- [x] 1.1 `frontend/src/routes/retiredRoutes.test.tsx` (new): the scenarios of `redirect-generic` and
  `redirect-decision-space` (run, study, run without study, jobs and reports, empty values, encoding, history entry
  replaced, signed out first, every target routed to the screen it names with encoded segments, no organization page
  for `/app/analysis`); the rendered ones are in the same file.
- [x] 1.2 `frontend/src/routes/retiredRoutes.tsx` (new) and `frontend/src/routes/index.tsx`: the table
  (`readonly RetiredRoute[]` with `slice`) and its `<Navigate replace>` routes inside the protected application layout
  (design.md §2).
- [x] 1.3 `frontend/src/routes/routes.test.ts`, `frontend/src/routes/d6.tsx`: drop `analysis-sources` and
  `analysis-workspace`; 80 screens, D6 10; the test title no longer says "of the prototype" (`screens-not-routed`,
  `screen-count`).
- [x] 1.4 Delete `frontend/src/pages/Analysis/` with its tests; move `SavedDecision.tsx` to `pages/Reports/` with the
  `unrecognised reference` fallback (design.md §4), tested in `pages/Reports/SavedDecision.test.tsx`; check whether
  `pages/Platform/AnalysisPage.css` is still imported.
- [x] 1.5 `frontend/src/routes/links.test.ts`: the literal scan `retiredAddresses` with its synthetic controls and the
  run on the sources, driven by the paths of `RETIRED_ROUTES`; drop the expectation of
  `/app/analysis/workspace?job=…` (`no-link-to-retired`).
- [x] 1.6 Remove the links of design.md §3 from `JobDetail.tsx`, `JobList.tsx`, `JobHistory.tsx`,
  `BindingAnalysis.tsx`, `StudyAnalytics.tsx` and `RepDetail.tsx`, and update their tests to assert the links are
  absent.
- [x] 1.7 `components/PlatformShell/appNavigation.ts` and its tests, `AppHeader.test.tsx`, `PlatformShell.test.tsx`:
  no Analysis entry, no `analysis` section (`navigation`).
- [x] 1.8 `components/PlatformShell/paletteCommands.ts` and a new `paletteCommands.test.ts` (organizations, projects
  and administrator given): no Analysis command (`palette`).
- [x] 1.9 `frontend/src/test/rawRenderingAllowList.ts` and `rawRenderingHygiene.test.ts`: remove offender 7 and
  unlisted finding 17; `MAX_ALLOWED_OFFENDERS` 14; `ceilingMismatch` with its controls; offender numbers exactly
  1–6, 8–15 and unlisted 16 (`allow-list-leaves`, `allow-list-ceiling`).
- [x] 1.10 Playwright (specs edited; not run in this task): `e2e/s7b-reports.spec.ts`, `e2e/qa-gallery.spec.ts` (`e2e/analysis-live.spec.ts` is deleted),
  `e2e/helpers/galleryRoutes.ts`, `e2e/visual-shell.spec.ts`, `e2e/s6a-jobs.spec.ts` and `e2e/s7a-studies.spec.ts`
  stop opening or expecting the retired addresses; one smoke step opens `/app/analysis?org=…&study=…` and lands on the
  study page.
- [ ] 1.11 Confirm the diff touches nothing under `openbinding-gateway/`, `engines/` or `docs/openapi.json`
  (`gateway-untouched`; a review check of the PR diff, no test).
- Acceptance: the frontend suite, eslint and tsc pass; every scenario of the ten requirements has a test or, for
  `gateway-untouched`, the diff check and the gateway's existing tests.

## S2. Report editor (follow-up slice, not done)
- [ ] 2.1 Specify: retired ids and paths, redirect targets, links, offender 5 (`pages/Reports/RepDetail.tsx`) and the
  moved `SavedDecision.tsx`; new screen count and ceiling.
- [ ] 2.2 Build and test as S1.

## S3. Library catalogue and project resources (follow-up slice, not done)
- [ ] 3.1 Specify: retired ids and paths (organization library, project library and resources), redirect targets,
  links, offender 11; new screen count and ceiling.
- [ ] 3.2 Build and test as S1.

## S4. Composer (follow-up slice, not done)
- [ ] 4.1 Specify: retired id and path, redirect target, links; new screen count.
- [ ] 4.2 Build and test as S1.

## S5. Sponsorship (follow-up slice, not done)
- [ ] 5.1 Specify: retired id and path, redirect target, links; new screen count.
- [ ] 5.2 Build and test as S1.

## S6. Review, then archive later (open)
- [ ] 6.1 Review sign-off of each slice PR (G11).
- [ ] 6.2 Archive (separate, explicit archive task, after S5):
  `["openspec", "archive", "m24-retire-screens", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- Owner CRP: `Deprecation` and `Sunset` headers on the retired endpoints, then their removal with the `analysis` queue
  and worker (ROADMAP M2.4, M9.6).
- Archive of `m21-rendering-catalogue`: its scenario "Today's offenders are listed" (15, exactly 1–15) no longer holds
  after S1 (design.md §5).
- The trade-off set on the run and study pages (ADR-0020 decision 3): a later milestone.
- Living spec `frontend-workspace` TODO about "82 screens of the prototype": updated when this change is archived.
