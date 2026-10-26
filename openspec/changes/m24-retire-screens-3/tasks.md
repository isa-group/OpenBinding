# Tasks: m24-retire-screens-3

Slice 3 of M2.4 (library catalogue and project resources), one PR. Tests carry
`[utest->req~frontend-retire-library-<name>~1]`, code `[impl->…]` (design.md §6).

Checks the slice registers (frontend directory, frozen install first): vitest, eslint and tsc in the
`bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec …'` form; the touched Playwright specs; the gateway
test `tests/test_b2_resolve_urls.py` through its registered check; `openspec validate m24-retire-screens-3 --strict`
once the lab has the CLI (until then CI runs `openspec validate --strict --all`).

## S3. Library catalogue and project resources (tests first)

Tests first:
- [ ] 3.1 `routes/retiredRoutes.test.tsx`: the `library-redirect` scenarios (targets, encoding, query and hash dropped,
  history replaced, signed out first with `state.from`, the four ties, targets routed); slice-1/2 cases limited to
  their `slice`.
- [ ] 3.2 `routes/routes.test.ts`: ids and paths gone, D4 list of eleven, 71 screens, D4 11; `retiredScreens.test.tsx`:
  71 and 12.
- [ ] 3.3 `routes/links.test.ts`: slice-3 full and tail forms, look-alikes, `src/api/` exemption, application sources.
- [ ] 3.4 `SectionNav.test.tsx`, `paletteCommands.test.ts`, `appNavigation.test.ts`, `workspacePath.test.ts`
  (`library-navigation`).
- [ ] 3.5 `test/rawRenderingHygiene.test.ts`: offenders 1–4, 6, 8–10, 12–15, ceiling 12, unlisted 16 only.
- [ ] 3.6 Page tests asserting absence (`library-entry-points-removed`): `CaseComposer`, `CaseList`, `CaseRevision`,
  `JobLaunch`, `JobDetail`, `OrgOverview`, `CollDetail`, `AppHome`; `Resolve.test.tsx` (`<base>/collections`).

Source:
- [ ] 3.7 `routes/retiredRoutes.tsx`: seven `slice: 3` entries in the order of design.md §2; `index.tsx` comment.
- [ ] 3.8 `routes/d4.tsx`: drop the seven screens and their lazy imports; header "11 screens".
- [ ] 3.9 Delete the files of `pages/Library/` and `pages/Resources/` that nothing imports (design.md §1), with their
  tests; `utils/bimVocabulary.ts` loses `migrateContent`.
- [ ] 3.10 Links of design.md §3 and `ProjectLibraryNav`.
- [ ] 3.11 `test/rawRenderingAllowList.ts`: remove offender 11; `MAX_ALLOWED_OFFENDERS` 12.

Outside `frontend/src`:
- [ ] 3.12 Playwright: `qa-gallery.spec.ts`, `helpers/galleryRoutes.ts` and `routes-smoke.spec.ts` at 71 screens;
  `s5b-library.spec.ts` reduced to two redirect smokes; `s5c-files.spec.ts` without the retired screens;
  `f2-ranges.spec.ts` without the `Edit the candidate`/`edit the candidates` links; the other specs that name the
  `Library` tab or library links.
- [ ] 3.13 `openbinding-gateway/tests/test_b2_resolve_urls.py`: `KNOWN_REDIRECTING_WEB_URLS` lists
  `/app/:org/library/:artifact/versions/:version` (the only gateway file the diff touches).
- [ ] 3.14 `ROADMAP.md`: M2 and M2.4 slice status (never the `Status: PROPOSED` lines).
- [ ] 3.15 `docs/agent-work/m24-retire-screens-3/review/how-to-test.md`: redirects, `Collections` tab and command,
  removed entry points.
- [ ] 3.16 Confirm the diff touches no gateway source, engine, worker, `docs/openapi.json` or `api/library*.ts`.
- [ ] 3.17 Review sign-off (G11).
- Acceptance: frontend suite, eslint, tsc and the gateway test pass; every scenario of the seven requirements has a test.

## Archive (later)
- [ ] Archive in an explicit archive task after S5, with `m24-retire-screens` and `m24-retire-screens-2`:
  `["openspec", "archive", "m24-retire-screens-3", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- Delete the leftover stub files of `pages/Library/` and `pages/Resources/` and the temporary Library fixtures
  (`pages/Library/fixtures.ts`) once `e2e/helpers/mockApi.ts` no longer imports them.
- Reconcile at the archive the slice-1/2 scenarios slice 3 changes: "An artifact named reports keeps its screen", the
  tab lists with `Library`, 78 screens and D4 18, offender 11 and ceiling 13, and
  `req~frontend-retire-gateway-untouched~1` (one gateway test file changes) (design.md §6).
- Retarget the gateway resolver's `library_version_url` and drop its `KNOWN_REDIRECTING_WEB_URLS` entry (M9.6 or
  earlier).
- Owner CRP: `Deprecation` and `Sunset` on the library and resource endpoints, then their removal with
  `api/library*.ts` (M2.4, M9.6).
- S4 composer (`case-composer`) and S5 sponsorship (`admin-sponsor`): specified when built.
