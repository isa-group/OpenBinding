# Tasks: m26-navigation

## Conventions

- **Slices.** Fifteen slices in order. Each is one PR of about 300 added or changed lines or fewer; deletions and
  moves do not count (constitution 14.1). Review moves with `git diff --color-moved`.
- **Tags.** Tests carry `[utest->req~frontend-nav-<name>~1]` and code carries `[impl->…]` (design.md §9).
- **Paths.** F = `frontend/src/`, R = `F/routes/areas/`, P = `F/routes/paths/`, E = `frontend/e2e/`,
  G = `E/helpers/gallery/`.
- **Risk.** A slice that touches `F/routes/**` is high risk (R1). The other slices are medium (R9).
- **Tests first.** Every slice with visible behaviour gets a test-designer task first. It writes
  `acceptance/ui/navigation/<slug>.spec.ts` from this change, and a red-before check (G3) shows that the spec fails on
  the base commit. The implementer then writes unit tests before code.
- **Scenarios state the final addresses.** The scenarios use `/problems`, `/runs` and `/published`, which exist only
  from slices 13 and 14 (`/published` from slice 5). Until then:
  - the acceptance specs and unit tests of slices 5 to 11 build every problem and run address with the builders of
    `P/problems.ts` and `P/runs.ts`, which return the `cases` and `jobs` forms;
  - T-UP and T-UR re-run those acceptance specs on the literal `/problems` and `/runs` addresses of the scenarios.
- **Shared files.**
  - `F/test/rawRenderingAllowList.ts` has one writer at a time (slices 2 and 15).
  - `F/routes/{retiredRoutes.tsx,retiredRoutes.test.tsx,retiredScreens.test.tsx}` also have one writer at a time
    (slices 1, 5, 8, 9 and 14).
- **Superseded requirements.** Tests tagged with an M2.4 or M2.5 requirement that a slice supersedes are updated in
  that slice, and the PR names the requirement (design.md §7).

## Checks

Every frontend slice registers the frozen install first:
- FI: `["pnpm","--dir","frontend","install","--frozen-lockfile"]`
- UNIT: `["pnpm","--dir","frontend","test"]`, timeout 1200
- LINT: `["pnpm","--dir","frontend","lint"]`
- BUILD: `["pnpm","--dir","frontend","build"]`, timeout 900
- E2E: `["pnpm","--dir","frontend","exec","playwright","test","--project=mocked",<specs>]`, timeout 1800. The specs
  are the ones the slice owns, plus `routes-smoke.spec.ts`.
- ACC: `["pnpm","--dir","frontend","exec","playwright","test","--config","playwright.acceptance.config.ts","navigation/<slug>.spec.ts"]`
  (G4).
- G1: `["openspec","validate","m26-navigation","--strict"]`, whenever the slice edits this change.

## 1. Foundation: route areas, redirects, address builders, e2e areas (high)

The slice has no visible behaviour, so it uses characterization tests first and needs no test-designer task.

Requirements: `frontend-nav-route-areas`, `frontend-nav-redirects`.

The slice splits into three PRs:
- 1a `m26-route-areas`.
- 1b `m26-path-builders`, which can run beside 1a.
- 1c `m26-e2e-areas`, which follows 1a.

Tasks:
- [ ] 1.1 Characterization: a test that lists today's 69 ids and paths, unchanged after the move.
- [ ] 1.2 Move `d1..d8` into the fourteen files `R/<area>.tsx` (design.md §2), each with `R/<area>.test.ts`.
  - Add the test that rejects an area file without its test, and a screen declared in two areas.
  - `registry.ts` concatenates the areas; delete `d1..d8` and `routesByDomain`.
- [ ] 1.3 The moved-routes table and its redirect component (design.md §3, mounting):
  - `MOVED_ROUTES` is the concatenation of the areas' `redirects`;
  - the redirect component sits outside `ProtectedRoute`, after the screens;
  - the `keep` and `permanent` flags;
  - the test that every target is a routed screen;
  - the permanent-entry test.

  The table starts empty; each later slice adds its rows.
- [ ] 1.4 `routes/links.test.ts` also reads `MOVED_ROUTES` and skips `permanent` entries.
- [ ] 1.5 `F/routes/screenBudget.test.ts` with a ceiling of 69. Each slice lowers it to its count.
  - The M2.4 domain lists and sizes in `routes.test.ts` and `retiredScreens.test.tsx` become area lists and sizes
    (design.md §7).
- [ ] 1.6 (1b) Address builders `P/<area>.ts`. The hub files use them: `components/PlatformShell/{appNavigation,
  paletteCommands,workspacePath}.ts`, `{OrgNav,AccountNav,ProjectTabs,PlatformShell}.tsx`, `components/Navigation`,
  `SiteFooter`, `NotificationDropdown`, `ui/ErrorState`, `ui/SectionNav`, `pages/AppHome/AppHome.tsx`,
  `pages/System/States.tsx` and `pages/Home/homeContent.ts`.
- [ ] 1.7 (1c) `E/routes-smoke.spec.ts` reads the area files and visits every redirect entry. The QA gallery reads the
  per-area maps `G/<area>.ts`.
- Checks: FI, UNIT, LINT, BUILD, E2E(`routes-smoke.spec.ts`, `qa-gallery.spec.ts`).

## 2. Verify page (high)

Requirements: `frontend-nav-verify-page`, `-verify-permanent-links`, `-verify-signed-out`, `-verify-no-raw-json`.

Owns: `R/verify`+t, `P/verify.ts`, `F/pages/Verify/**` (new), `F/pages/Resolve/**` and `F/pages/Reports/Verifier*`
(removed), the `vf-*` rules of `F/pages/Reports/Reports.css`, `F/pages/Platform/verifierOptions*`,
`F/test/rawRenderingAllowList.ts`, `E/s1a-public.spec.ts`, `E/s7b-reports.spec.ts`, `G/verify.ts`.

Tasks:
- [ ] 2.1 T-V acceptance spec. Then unit tests:
  - the three modes;
  - signed-out requests only to `/v1/resolve/`;
  - the kind selector;
  - the `Log in` text, with a link to `/login` and no return to `/verify`;
  - the canonical JSON in a collapsed `SourceView`;
  - the ten kinds redirected, signed in and signed out;
  - `/app/verifier?digest=` redirected without `/login`;
  - copying a permanent link gives the `/resolve/...` form.
- [ ] 2.2 The `verify` screen; the moved entries `/resolve/:kind/:digest` and `/app/verifier` (`permanent`); delete
  `pub-resolve` and `verifier`.
- [ ] 2.3 Remove offender 6 and set `MAX_ALLOWED_OFFENDERS` to 0 (finding 16 stays unlisted until slice 15).
- [ ] 2.4 Repoint the links to `/app/verifier` in the hub files through `P/verify.ts`. Links to `/resolve/...` may stay.
- [ ] 2.5 The kind names of the Verify page use the glossary: `case-revision` reads `Problem version`
  (`frontend-nav-vocabulary-text`).
- Budget: 68.

## 3. Account sections (high)

Requirement: `frontend-nav-account-sections`.

Owns: `R/account`+t, `P/account.ts`, `F/pages/Account/**`, `F/components/PlatformShell/AccountNav*`,
`E/s3-account.spec.ts`, `G/account.ts`.

Tasks:
- [ ] 3.1 T-AC acceptance spec. Then unit tests: each section, an unknown section, the `create=key` dialog.
- [ ] 3.2 `acct-profile` at `/app/account/:section?`. The new key becomes a dialog, with the moved entry
  `/app/account/keys/new`.
- [ ] 3.3 The account text uses the glossary, for example `Runs that may run at once` in the usage section
  (`frontend-nav-vocabulary-text`).
- Budget: 63.

## 4. Language hub and examples in Explore (high)

Requirements: `frontend-nav-language-hub`, `-examples-in-explore`.

Owns: `R/language`+t, `P/language.ts`, `F/pages/{Profiles,Schemas,Examples}/**`, `F/pages/Engines/LangExtensions*`,
`F/pages/Public/Explore*`, `F/pages/Home/**` (text only), `E/s1b-language.spec.ts`, `G/language.ts`, and the
Explore entry of `R/public`.

Tasks:
- [ ] 4.1 T-LH and T-EX acceptance specs. Then unit tests: the hub sections; Extensions signed out;
  `/language/schemas/<Kind>` kept; Explore `examples`; an unknown Explore section.
- [ ] 4.2 `lang-profiles` at `/language/:section?/:item?` and `pub-explore` at `/explore/:section?`.
  - Moved entries: `/app/language/extensions` and `/examples`.
  - Delete `lang-schemas`, `lang-extensions` and `lang-examples`.
- [ ] 4.3 The Explore, examples and public-home text uses the glossary, for example `Published results and public
  projects` and `Import as problem` (`frontend-nav-vocabulary-text`).
- Budget: 60.

## 5. Project tabs, Files and Package retired (high)

Requirements: `frontend-nav-project-tabs`, `-files-retired`.

Owns: `R/project`+t (not `proj-create`), `P/project.ts`, `F/components/PlatformShell/{ProjectTabs.tsx,SectionNav.test.tsx}`,
`F/utils/accessLevel*`, `F/pages/Project/**` except `ProjectCreate*`, `F/pages/Resources/ProjFiles*` (removed),
`F/pages/Reports/ProjPublications*`, `F/routes/{retiredRoutes.tsx,retiredRoutes.test.tsx,retiredScreens.test.tsx}`
(the reports target), `E/s4b-project.spec.ts`, `E/s5c-files.spec.ts` (removed), `G/project.ts`.

Tasks:
- [ ] 5.1 T-PT acceptance spec. Then unit tests: the tab labels and `href` values, the public visitor, the Settings
  sections, Export and Import in General, Members.
- [ ] 5.2 Tab labels: Problems, Runs, Published.
  - The `href` values come from the builders. `/problems` and `/runs` take effect with slices 13 and 14; until then
    the builders return `/cases` and `/jobs`.
  - `proj-publications` moves to `/published`, with the moved entry `/publications`.
  - Moved entries `/files` (`permanent`) and `/package`.
  - `proj-settings` at `/settings/:section?`.
- [ ] 5.3 The reports rule of `RETIRED_ROUTES` targets `…/published`. Update its tests: the "every target is a routed
  screen" case, and the M2.4 publications and tab-label cases (design.md §7).
- Budget: 58.

## 6. Organization settings sections and creation dialogs (high)

Requirements: `frontend-nav-org-settings-sections`, `-create-dialogs`.

Owns: `R/organizations`+t, the `proj-create` entry of `R/project`, `P/{organizations,project}.ts`,
`F/pages/Organization/**`, `F/pages/Project/ProjectCreate*`, `F/pages/AppHome/**`,
`F/components/PlatformShell/OrgNav*`, `E/{s4a-org,s4b-project}.spec.ts`, `G/organizations.ts`.

Tasks:
- [ ] 6.1 T-OS and T-CD acceptance specs. Then unit tests: the sections, an unknown section, the dialogs opened from
  buttons and from `create=`, Cancel, the old creation addresses.
- [ ] 6.2 `org-settings` at `/app/:org/settings/:section?`. The `create=organization` and `create=project` dialogs.
  - Moved entries: `/app/organizations/new` and `/app/:org/new-project`.
  - Delete `org-members`, `org-audit`, `org-create` and `proj-create`.
- Budget: 54.

## 7. System states, password reset, status (high)

Requirements: `frontend-nav-system-states-dev-only`, `-reset-single-screen`, `-status-retired`.

Owns: `R/{system,auth,public}`+t, `P/{auth,public}.ts`, `F/routes/{define.tsx,types.ts}`, `F/pages/System/**`,
`F/pages/Auth/PasswordReset*`, `F/pages/{Status,About}/**`, `F/components/SiteFooter/**`,
`E/{s2-auth,s1a-public}.spec.ts`, `G/{system,auth,public}.ts`.

Tasks:
- [ ] 7.1 T-AR and T-RS acceptance specs. Then unit tests: the token rule; the moved entry `/password-reset/complete`
  (`permanent`); `/status` to `/about`; the About note in its three states; the production registry without
  `sys-states`.
- [ ] 7.2 A development-only flag in `define.tsx` and `types.ts`. The lazy import sits behind `import.meta.env.DEV`.
- [ ] 7.3 Merge `auth-reset-complete` into `auth-reset-request`. Delete `pub-status`, and add the About note.
- Check, in addition, NOSTATES:
  `["bash","-c","set -euo pipefail; cd frontend; pnpm build > \"$TMPDIR/build.log\" 2>&1 || { tail -n 80 \"$TMPDIR/build.log\"; exit 1; }; if grep -rl 'States and recoverable errors' dist; then echo 'states screen in production bundle'; exit 1; fi"]`
- Budget: 51.

## 8. Study page (high)

Requirement: `frontend-nav-study-page`.

Owns: `R/studies`+t, `P/studies.ts`, `F/pages/Studies/**`,
`F/routes/{retiredRoutes.tsx,retiredRoutes.test.tsx,retiredScreens.test.tsx}` (the decision-space study target),
`E/s7a-studies.spec.ts`, `G/studies.ts`.

Tasks:
- [ ] 8.1 T-SP acceptance spec. Then unit tests:
  - the tabs and the default tab;
  - the run selector and the `run` query;
  - the three moved study-run addresses;
  - a cell inside Results with `Open run`;
  - an unknown tab;
  - the Setup tab keeping the M2.5 Overview/Source pair.
- [ ] 8.2 `study-detail` at `…/studies/:study/:tab?`. Delete `study-run`, `study-analytics` and `study-cell`. Publish
  holds the CSV export and a link to Published.
- [ ] 8.3 The decision-space rule's study-run target becomes `…/studies/<s>/progress?run=<r>`, with its tests
  (design.md §7). The studies text uses the glossary (`frontend-nav-vocabulary-text`).
- Budget: 48.

## 9. Problem page (high)

Requirement: `frontend-nav-problem-page`.

Owns: `R/problems`+t, `P/problems.ts`, `F/pages/Cases/**`, `F/pages/Platform/CaseDetailPage*`,
`F/routes/retiredScreens.test.tsx` (the composer's neighbouring case screens), `E/s5a-cases.spec.ts`, `G/problems.ts`.

Tasks:
- [ ] 9.1 T-PP acceptance spec. Then unit tests:
  - the tabs, and the tabs of a visitor;
  - the version selector and the `version` query;
  - the Source tab with `SourceView`;
  - Versions compare with `from` and `to`;
  - Settings (name, description);
  - the moved revision, compare and snapshot addresses;
  - an unknown tab.
- [ ] 9.2 `case-detail` at `…/cases/:case/:tab?`, which becomes `…/problems/:case/:tab?` with slice 13.
  - Moved entries: revisions (`permanent`), compare, snapshots (`permanent`).
  - Delete `case-revision`, `case-compare` and `snap-detail`.
  - The links in `pages/Jobs/**`, `pages/Studies/**` and `pages/Workbench/ActionBar.tsx` that open snapshots or
    revisions go through `P/problems.ts`. This is a one-line edit each, listed in the PR.
  - In `retiredScreens.test.tsx`, the M2.4 composer case "neighbouring case screens keep their addresses" now expects
    the compare and revision addresses to redirect to the problem page (design.md §7).
- Budget: 45.

## 10. Problem vocabulary (medium)

Requirement: `frontend-nav-vocabulary-text` (problem area).

Owns:
- `F/pages/Cases/**`;
- `F/pages/Workbench/**` except `SourcePanel*`;
- `F/pages/Resources/**`;
- `F/test/vocabulary.ts` (new scanner) and `F/test/vocabulary.problems.test.ts`;
- `E/{s5a-cases,s5b-library,s5d-workbench}.spec.ts`.

Tasks:
- [ ] 10.1 T-VP acceptance spec. Then the scanner test: the problem-area files hold none of the six words outside code.
- [ ] 10.2 Change the text: Case(s) becomes Problem(s), a problem's revision becomes its version, and `New case`
  becomes `New problem`.

## 11. Application navigation (medium)

Requirements: `frontend-nav-public-navigation`, `-signed-in-navigation`, `-new-menu`, `-account-menu`.

Owns: `F/components/PlatformShell/{AppHeader,appNavigation,paletteCommands,CommandPalette}*`,
`F/components/Navigation/**`, `F/pages/Cases/CaseList*` and `F/pages/Resources/CollList*` (the `create=` query
only), `E/{visual-shell,responsive}.spec.ts`.

Tasks:
- [ ] 11.1 T-N acceptance spec. Then unit tests:
  - the public header order and its `href` values, desktop and phone;
  - the signed-in header with and without a current project;
  - Admin shown only to administrators;
  - the New menu items, their targets, and the hint `Needs a project`;
  - the account menu.
- [ ] 11.2 Replace the Tools menu and the old New items. The palette commands follow the header.
- [ ] 11.3 The problem list opens its dialog `New problem` for `create=problem`, and the collection list opens
  `New collection` for `create=collection`. Closing a dialog removes the query.

## 12. Run vocabulary (medium)

Requirement: `frontend-nav-vocabulary-text` (run area, then every remaining file).

Owns:
- `F/pages/Jobs/**`;
- `F/pages/Account/notificationsModel*`;
- text-only edits in `F/pages/{Admin,Engines,Generator,Platform}/**`, and in any other file the scanner reports that
  no running slice holds;
- `F/test/vocabulary.runs.test.ts` and `F/test/vocabulary.rest.test.ts`;
- `E/{s6a-jobs,s9a-admin}.spec.ts`.

Tasks:
- [ ] 12.1 T-VR acceptance spec. Then scanner tests, first for the run area and then for every other source.
- [ ] 12.2 Change the text: Job(s) becomes Run(s), and Publication(s) becomes Published result(s). The edits cover
  `pages/Jobs/**` and then every file the scanner still reports. Examples: `Jobs by state`, `Job queue` and
  `Reconcile jobs` in `pages/Admin/**`. The engine-registration publication text stays (design.md §11.18).

## 13. Problem addresses (high, serial)

Requirement: `frontend-nav-vocabulary-urls` (`cases` → `problems`).

Owns: `R/{problems,collections}`, `P/problems.ts`, every file with a `/cases` link literal, and the E specs that name
them.

Tasks:
- [ ] 13.1 T-UP acceptance spec. Then tests:
  - the registry paths;
  - the address scan on synthetic sources;
  - the API paths unchanged;
  - the moved entries `/cases` and `/cases/:case`.
- [ ] 13.2 `case-list` moves to `…/problems`, and `case-detail` to `…/problems/:case/:tab?`. The builders and the
  literals follow, and the earlier moved entries now target `/problems`.

## 14. Run addresses (high, serial)

Requirement: `frontend-nav-vocabulary-urls` (`jobs` → `runs`).

Owns: `R/runs`+t, `P/runs.ts`, every file with a `/jobs` link literal,
`F/routes/{retiredRoutes.tsx,retiredRoutes.test.tsx,retiredScreens.test.tsx}` (the `/app/jobs` target),
`E/s6a-jobs.spec.ts`, `G/runs.ts`.

Tasks:
- [ ] 14.1 T-UR acceptance spec. Then tests: the registry paths; the moved entries `/app/jobs`, `…/jobs`,
  `…/jobs/new` and `…/jobs/:job`; `runs` as a reserved organization slug.
- [ ] 14.2 `job-*` moves to `…/runs`, and `job-history` to `/app/runs`. The builders and the literals follow. The
  decision-space rule's fallback target becomes `/app/runs`, with its tests (design.md §7).

## 15. Final budget and empty allow-list (high, last)

Requirements: `frontend-nav-screen-budget`, `-allow-list-empty`, and `frontend-nav-vocabulary-text` (final
assertion).

Owns: `F/routes/screenBudget.test.ts`, `E/routes-smoke.spec.ts`, `F/test/rawRenderingAllowList.ts`,
`F/test/rawRenderingHygiene.test.ts`, `F/pages/Workbench/SourcePanel*`.

Tasks:
- [ ] 15.1 Tests:
  - the budget at `≤ 45`, with the area sizes;
  - an empty allow-list and an empty unlisted list;
  - the diff in `SourceView`;
  - the route smoke rejects the six words, and every redirect lands on a screen.
- [ ] 15.2 `SourcePanel` shows its diff through `SourceView`, labelled `Changes to <path>`. `UNLISTED_FINDINGS`
  becomes empty.
- Check: E2E with no arguments, which runs every mocked spec.

## Archive (later)

- [ ] Archive in an explicit archive task:
  1. archive M2.4 and M2.5 first;
  2. turn the rows of design.md §7 into REMOVED or MODIFIED entries, or updated values;
  3. run `["openspec","archive","m26-navigation","--yes"]`;
  4. run `["openspec","validate","--all","--strict"]` and the trace.

## Follow-ups outside this change

- The gateway emits the new frontend addresses: `/verify/...`, `/password-reset?token=`, and `…/problems/<case>?version=`
  in `web_url`. The permanent entries stay even after that.
- Returning to `/verify` after sign-in: `utils/authFlow.ts` has to keep the Verify address across the login. The Verify
  page's `Log in` link goes to `/login` until then, and the visitor lands on `/app`.
- `ROADMAP.md`: the M2.6 slice status (never its `Status: PROPOSED` lines).
