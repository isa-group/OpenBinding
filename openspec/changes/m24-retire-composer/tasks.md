# Tasks: m24-retire-composer

Slice 4 of M2.4 (composer), one PR. Tests carry `[utest->req~frontend-retire-composer-<name>~1]`, code `[impl->…]`
(design.md §6). Diff budget: the PR adds or changes about 300 lines or fewer; deletions (the page, its test, styles and
helpers) do not count against it (constitution 14.1).

Checks the slice registers (frontend directory, frozen install first): vitest, eslint and tsc in the
`bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec …'` form; the touched Playwright specs;
`openspec validate m24-retire-composer --strict` once the lab has the CLI (until then CI runs
`openspec validate --strict --all`).

## S4. Composer (tests first)

Tests first:
- [ ] 4.1 `routes/retiredRoutes.test.tsx`: the `composer-redirect` scenarios (target, encoding, query and hash dropped,
  history replaced, signed out first with `state.from`, neighbouring case screens kept, the two ties with the library
  entries, target routed to `wb-workbench`); the pure `target` with an absent `org`, `project` or `case` gives `/app`;
  slice-1/2/3 cases limited to their `slice`.
- [ ] 4.2 `routes/routes.test.ts`: id and path gone, D4 list of ten, 70 screens, D4 10; `retiredScreens.test.tsx`: 70
  and 12.
- [ ] 4.3 `routes/links.test.ts`: slice-4 full and tail forms, look-alikes and replacements, application sources, one
  slice-4 entry.
- [ ] 4.4 Page tests (`composer-entry-points-repointed`): `pages/Cases/CaseList.test.tsx` (row action, notice, empty
  state, viewer), `CaseDetail.test.tsx` (header action, first-revision guide, revision without snapshot, viewer),
  `CaseCompare.test.tsx` (`New revision` of the one-revision guide, viewer; also `composer-no-link`), `pages/Jobs/JobDetail.test.tsx`
  (`Try faster providers`, `See the rules`).

Source:
- [ ] 4.5 `routes/retiredRoutes.tsx`: `workbenchTarget` and the entry `case-composer` with `slice: 4` after the slice-3
  entries (design.md §2); `index.tsx` comment if it lists the slices.
- [ ] 4.6 `routes/d4.tsx`: drop `case-composer` and its lazy import; header "10 screens".
- [ ] 4.7 Delete `pages/Cases/CaseComposer.tsx` and `CaseComposer.test.tsx`; remove the composer rules of `Cases.css`
  and its header mention; delete the helpers only the composer imports (design.md §1), with their tests or test cases.
- [ ] 4.8 Links and texts of design.md §3: `CaseList.tsx`, `CaseDetail.tsx`, `CaseCompare.tsx`, `pages/Jobs/JobResult.tsx`.
- [ ] 4.9 `api/library.ts`: only its doc comment may drop the mention of the case composer; no function changes.

Outside `frontend/src`:
- [ ] 4.10 Playwright: `e2e/s5a-cases.spec.ts` drops the `case-composer` test (its header comment too) and repoints the
  `New revision`, `Compose its first revision` and `Compose the first revision` assertions to
  `<root>/workbench?case=<slug>`, with one redirect smoke from `${CASE}/compose`; `e2e/qa-gallery.spec.ts` (without the
  `case-composer` expectation) and `e2e/routes-smoke.spec.ts` at 70 screens (`e2e/helpers/galleryRoutes.ts` names no
  composer; it changes only if it counts screens); `e2e/live/03-case-simple-seq.spec.ts`: the member test no longer
  says "compose" and asserts that `New revision` leads to `${PROJECT_PATH}/workbench?case=${CASE}`.
- [ ] 4.11 `ROADMAP.md`: the M2 row and the M2.4 "Slice status" paragraph record slice 4 (never the
  `Status: PROPOSED` lines).
- [ ] 4.12 `docs/agent-work/m24-retire-composer/review/how-to-test.md` from `how-to-test.md` of this change, with the
  results of the preview.
- [ ] 4.13 Confirm the diff touches no gateway source or test, engine, worker, `docs/openapi.json` or `api/*.ts` function,
  and that `MAX_ALLOWED_OFFENDERS` stays 12.
- [ ] 4.14 Review sign-off (G11).
- Acceptance: frontend suite, eslint, tsc and the touched Playwright specs pass; every scenario of the five requirements
  has a test.

## Archive (later)
- [ ] Archive in an explicit archive task after S5, with `m24-retire-screens`, `m24-retire-screens-2` and
  `m24-retire-screens-3`: `["openspec", "archive", "m24-retire-composer", "--yes"]`, then
  `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- Reconcile at the archive the earlier scenarios slice 4 changes: slice 3's D4 list with `case-composer`, 71 screens
  and D4 11, the Evidence `CaseComposer.test.tsx` and the scenario "Composer and case list" of
  `req~frontend-retire-library-entry-points-removed~1`; slice 1's counts and `req~frontend-retire-redirect-generic~1`
  (a target with a query) (design.md §6).
- S5 sponsorship (`admin-sponsor`): a separate change, specified when built.
- Owner CRP: `Deprecation` and `Sunset` on the retired endpoints, then their removal with the unused API client reads
  (M2.4, M9.6).
- The full problem editor in the workbench (M3.6).
