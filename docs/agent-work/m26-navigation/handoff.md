# Handoff: m26-navigation
- Status: waiting-review (plan for the coordinator; D-M26-1 to D-M26-7 for the owner) · Updated: 2026-10-27T12:00:00Z
- Branch / head: task branch on 00f653ef · PR: none (planning only)

## Goal
Slice ROADMAP M2.6 (owner request own-a88d098d12d0454793fb64673a109fbe) into changes of one capability each. M2.6
covers the §5.2 navigation and project tabs, the Problem/Run vocabulary, the Verify page (offender 6) and a
development-only system-states screen. Acceptance: route smoke green, old URLs redirect, allow-list empty, ≤ 45
routed screens. Facts F1-F18, the screen budget and the decisions are in [intake.md](intake.md).

## State (with evidence)
- Nothing of M2.6 is built.
  - The registry has 69 screens (`frontend/src/routes/routes.test.ts:63-66`).
  - Offender 6 is still allowed (`frontend/src/test/rawRenderingAllowList.ts:72-78`).
  - `sys-states` is registered in every build (`d1.tsx:43`).
- M2.3 and M2.5 have not started (F2). M2.4 slice 5 is under review and holds the shared route tests (F2).
- The inbox body file named in the brief does not exist. The plan follows the brief and `ROADMAP.md:71`.
- No check was run: this task has no registered check, and its output is two documents.

## Decisions (planner; the coordinator may override)
- Wave 0 makes every later slice own its own files.
  - A1 splits `d1..d8` into area files `routes/areas/<area>.tsx`, each exporting its routes and its redirects, with its
    own `<area>.test.ts`. It adds redirects in the public layout and a budget test pinned at 69.
  - A2 adds address builders `routes/paths/<area>.ts` and makes the hub files use them.
  - A3 makes the smoke and the gallery read the area files and the per-area gallery maps
    (`e2e/helpers/gallery/<area>.ts`).

  Reason: F5-F7 and F15. Today every slice would edit `routes.test.ts` and `qa-gallery.spec.ts`.
- Areas used in A1 (69 = 5+6+2+1+4+5+6+6+6+7+2+5+6+8):
  - public: pub-home, explore, about, status, pricing
  - auth: the five auth screens and invite-accept
  - verify: resolve, verifier
  - system: sys-states
  - language: profiles, schemas, examples, extensions
  - engines: five screens
  - account: six acct-* screens
  - organizations: app-home, org-*
  - project: proj-* and proj-publications
  - problems: case-*, snap-detail, both workbenches
  - collections: coll-*
  - runs: job-* and gen-lab
  - studies: study-*
  - admin: admin-*
- Merged sections keep their addresses through an optional segment, so they need no redirect and no link edits in
  other areas. `/resolve/:kind/:digest` redirects to Verify for good. It is marked `permanent`, so `links.test.ts`
  still allows links to it (intake §3.2).
- Verify keeps the API as it is (D-M26-4 A). The canonical JSON goes into a collapsed `SourceView`. `VerifyResult` and
  digest labels stay in M2.7.
- No feature flag. Each slice leaves its own screens consistent, and R1 is not cut before Z (intake §3.5).

## Slices
Paths: F = `frontend/src/`, R = `F/routes/areas/`, P = `F/routes/paths/`, G = `frontend/e2e/helpers/gallery/`,
E = `frontend/e2e/`. "+t" means the file and its tests. Each implementation slice stays at or under ~300 non-test
lines, deletions excluded. A1 is mostly moves: review it with `git diff --color-moved`. Specifier tasks own
`openspec/changes/<id>/**`. Test-designer tasks (T-x, 40 turns, medium) own `acceptance/ui/navigation/<slug>.spec.ts`,
start when their change passes G1, and must be frozen before the slice starts. Risk is high wherever `F/routes/**` is
touched (R1, panel: reviewer, test-reviewer, security-auditor, arch-reviewer), otherwise medium (R9: reviewer,
test-reviewer). Every UI slice adds ui-qa.

| Id | Change · role · turns | Risk | Owns (exclusive while running) | Starts after | Parallel |
|---|---|---|---|---|---|
| S0a-e | specs, see below · specifier · 60 each | medium | `openspec/changes/m26-*/**` (disjoint per task) | **now** | all |
| A1 | m26-route-areas · refactorer · 80 | high | `F/routes/**` except `F/routes/paths/**` | M2.4 slice 5 merged, S0a | with A2 |
| A2 | m26-path-builders · refactorer · 60 | high | `P/**`; hubs +t: `F/components/PlatformShell/{appNavigation,paletteCommands,workspacePath}.ts`, `{OrgNav,AccountNav,ProjectTabs,PlatformShell}.tsx`, `F/components/{Navigation/Navigation,SiteFooter/SiteFooter,NotificationDropdown/NotificationDropdown,ui/ErrorState,ui/SectionNav}.tsx`, `F/pages/AppHome/AppHome.tsx`, `F/pages/System/States.tsx`, `F/pages/Home/homeContent.ts` | S0a | with A1 |
| A3 | m26-e2e-areas · implementer · 40 | medium | `E/routes-smoke.spec.ts` (also visits every redirect), `E/qa-gallery.spec.ts`, `E/helpers/galleryRoutes.ts`, `G/**` | A1 | — |
| V | m26-verify-page · implementer · 80 | high | `R/verify`+t, `P/verify.ts`, `F/pages/Verify/**` (new), `F/pages/Resolve/**` (removed), `F/pages/Reports/Verifier*` (removed), the `vf-*` rules of `F/pages/Reports/Reports.css`, `F/pages/Platform/verifierOptions*`, `F/test/rawRenderingAllowList.ts` (lock), `E/s1a-public.spec.ts`, `E/s7b-reports.spec.ts`, `G/verify.ts` | A1-A3, T-V | wave 1 |
| S | m26-system-states-dev-only · implementer · 40 | high | `R/system`+t, `F/routes/{define.tsx,types.ts,registry.ts,screenBudget.test.ts}`, `F/pages/System/**`, `G/system.ts` | A1-A3 | wave 1 |
| AC | m26-account-sections · implementer · 80 | high | `R/account`+t, `P/account.ts`, `F/pages/Account/**`, `F/components/PlatformShell/AccountNav*`, `E/s3-account.spec.ts`, `G/account.ts` | A1-A3, T-AC | wave 1 |
| LH | m26-language-hub · implementer · 70 | high | `R/language`+t (not the examples entry), `P/language.ts`, `F/pages/{Profiles,Schemas}/**`, `F/pages/Engines/LangExtensions*`, `E/s1b-language.spec.ts`, `G/language.ts` | A1-A3, T-LH | wave 1 |
| AR | m26-auth-reset-screen · implementer · 30 | high | `R/auth`+t, `P/auth.ts`, `F/pages/Auth/PasswordReset*`, `E/s2-auth.spec.ts`, `G/auth.ts` | A1-A3, T-AR | wave 1 |
| PT | m26-project-tabs · implementer · 80 | high | `R/project`+t (not proj-create), `P/project.ts`, `F/components/PlatformShell/{ProjectTabs.tsx,SectionNav.test.tsx}`, `F/utils/accessLevel*`, `F/pages/Project/**` except ProjectCreate, `F/pages/Resources/ProjFiles*`, `F/pages/Reports/ProjPublications*`, `F/routes/retiredRoutes{.tsx,.test.tsx}` (publications target), `E/s4b-project.spec.ts`, `E/s5c-files.spec.ts`, `G/project.ts` | A1-A3, T-PT | wave 1 |
| VP | m26-vocabulary-problems · implementer · 70 | medium | `F/pages/Cases/**` except SnapshotDetail; `F/pages/Workbench/**` except RunPanel, CheckResult and SourcePanel; `F/pages/Resources/**` except ProjFiles; `F/pages/Platform/CaseDetailPage*`; `F/test/vocabulary.ts` (new scanner); `F/test/vocabulary.problems.test.ts`; `E/{s5a-cases,s5b-library,s5d-workbench}.spec.ts` | A2, T-VP; no M2.3 slice holding `pages/Workbench/**` | wave 1 |
| N | m26-app-navigation · implementer · 80 | medium | `F/components/PlatformShell/{AppHeader,appNavigation,paletteCommands,CommandPalette}*`, `F/components/Navigation/**`, `E/{visual-shell,responsive}.spec.ts` | V, AC, LH, T-N | wave 2 |
| OS | m26-org-settings-sections · implementer · 60 | high | `R/organizations`+t (not org-create), `P/organizations.ts`, `F/pages/Organization/**` except OrgCreate, `F/components/PlatformShell/OrgNav*`, `E/s4a-org.spec.ts`, `G/organizations.ts` | M2.5 offender 12, T-OS | wave 2 |
| EX | m26-examples-in-explore · implementer · 50 | high | the examples entry of `R/language`, `P/language.ts`, `F/pages/Examples/**`, `F/pages/Public/Explore*`, `E/s1a-public.spec.ts`, `G/language.ts` | LH, V, T-EX | wave 2 |
| RS | m26-retire-status · implementer · 30 | high | `R/public`+t, `P/public.ts`, `F/pages/{Status,About}/**`, `F/components/SiteFooter/**`, `G/public.ts`, `E/s1a-public.spec.ts` | EX, D-M26-3, T-RS | after EX |
| CD | m26-create-dialogs · implementer · 70 | high | the org-create entry of `R/organizations`, the proj-create entry of `R/project`, `P/{organizations,project}.ts`, `F/pages/{Organization/OrgCreate,Project/ProjectCreate}*`, `F/pages/AppHome/**`, `E/{s4a-org,s4b-project}.spec.ts`, `G/{organizations,project}.ts` | OS, PT, N, T-CD | after OS |
| VR | m26-vocabulary-runs · implementer · 70 | medium | `F/pages/Jobs/**`, `F/pages/Admin/AdminQueues*`, `F/pages/Account/notificationsModel*`, `F/test/vocabulary.runs.test.ts`, `E/s6a-jobs.spec.ts` | all of M2.3, VP, AC, T-VR | wave 2 |
| SP | m26-study-page · implementer · 80 | high | `R/studies`+t, `P/studies.ts`, `F/pages/Studies/**`, `E/s7a-studies.spec.ts`, `G/studies.ts` | M2.5 offenders 8 and 9, T-SP | wave 3 |
| PP | m26-problem-page-tabs · implementer · 80 | high | `R/problems`+t, `P/problems.ts`, `F/pages/Cases/**`, `F/pages/Platform/CaseDetailPage*`, `E/s5a-cases.spec.ts`, `G/problems.ts` | M2.5 offender 15, VP, D-M26-2, T-PP | wave 3 |
| SD | m26-source-diff · implementer · 40 | medium | `F/pages/Workbench/SourcePanel*`, `F/components/rendering/SourceView*` (lock), `F/test/rawRenderingAllowList.ts` (lock) | all of M2.3, D-M26-7, T-SD | wave 3 |
| UP | m26-problem-urls · implementer · 70 | high | `R/problems`, `R/collections`, `P/problems.ts`, every file with a `/cases` link literal (F15), the E specs that name them | PP, VP, VR, D-M26-6, T-UP | serial |
| UR | m26-run-urls · implementer · 70 | high | `R/runs`+t, `P/runs.ts`, every file with a `/jobs` link literal, `E/s6a-jobs.spec.ts`, `G/runs.ts` | UP, SP, VR, T-UR | serial |
| Z | m26-screen-budget · implementer · 50 | high | `F/routes/screenBudget.test.ts` (≤ 45), `E/routes-smoke.spec.ts` (no Case/Job text, every redirect lands), `F/test/rawRenderingAllowList.ts` (lock), `F/test/rawRenderingHygiene.test.ts` | every slice above, all of M2.3 and M2.5 | last |

Specification tasks (wave 0, in parallel). Proposed requirement ids are named `req~frontend-workspace-<name>~1`; the
specifier finalizes them in EARS form. Changes that wait on a decision mark `PENDING D-M26-n`.
- S0a: route-areas (`route-areas`, `public-redirects`, `screen-budget`, MODIFIED `route-registry~2`); path-builders;
  e2e-areas; system-states-dev-only (`states-dev-only`).
- S0b: verify-page. A `resolver-verifier` delta: `verify-page`, `verify-permanent-links`, `verify-signed-out`,
  `verify-no-raw-source`.
- S0c: account-sections, org-settings-sections, create-dialogs, auth-reset-screen.
- S0d: app-navigation (`public-navigation`, `signed-in-navigation`, `new-menu`, `account-menu`), project-tabs,
  language-hub, examples-in-explore, retire-status.
- S0e: vocabulary-problems, vocabulary-runs (`vocabulary-ui-text`), problem-urls, run-urls (`vocabulary-urls`),
  study-page, problem-page-tabs, source-diff, screen-budget.

There is no T-x for A1, A2, A3 or S. They add no visible behaviour, so they write characterization or unit tests first.
S proves the bundle with the NOSTATES check below. Cross-area link lines: V, AC, OS, PT and LH change only the link
lines they own above. Any other old address in another area is reached through a builder (A2) or still resolves
(optional segment, §Decisions).

## Checks (proposed argv; register per slice)
| Name | argv |
|---|---|
| FI | `["pnpm","--dir","frontend","install","--frozen-lockfile"]`, first in every frontend slice |
| VT(x…) | `["pnpm","--dir","frontend","exec","vitest","run",x…]` |
| UNIT | `["pnpm","--dir","frontend","test"]`, timeout 1200 |
| LINT | `["pnpm","--dir","frontend","lint"]` |
| BUILD | `["pnpm","--dir","frontend","build"]`, timeout 900 |
| E2E(x…) | `["pnpm","--dir","frontend","exec","playwright","test","--project=mocked",x…]`, timeout 1800, needs playwright-chromium |
| ACC(s) | `["pnpm","--dir","frontend","exec","playwright","test","--config","playwright.acceptance.config.ts","navigation/<s>.spec.ts"]`, gate G4 |
| RED(s) | `{"argv": ACC(s), "type":"red_before","expect_exit":[1],"expect_pattern":"Error: expect","overlay":["acceptance/ui/navigation/<s>.spec.ts"],"gate":"G3"}` |
| G1(c) | `["openspec","validate","<c>","--strict"]` |
| NOSTATES | `["bash","-c","set -euo pipefail; cd frontend; pnpm build > \"$TMPDIR/build.log\" 2>&1 \|\| { tail -n 80 \"$TMPDIR/build.log\"; exit 1; }; if grep -rl 'States and recoverable errors' dist; then echo 'states screen in production bundle'; exit 1; fi"]` |

- S0a-e: G1 for each of their changes, then gate G2. T-x: RED(slug) (gate G3).
- A1 and A2: FI, UNIT, LINT, BUILD, E2E(`routes-smoke.spec.ts`). A3: FI, E2E(`routes-smoke.spec.ts`, `qa-gallery.spec.ts`).
- Wave 1 to Z: FI, UNIT, LINT, BUILD, E2E(the owned specs plus `routes-smoke.spec.ts`), ACC(slug).
  - S adds NOSTATES.
  - Z runs E2E with no arguments (every mocked spec).
- Preview: every UI slice is shown in the lab preview before it merges (principle 10).

## Open questions and risks
- D-M26-1 to D-M26-7 (intake §4) wait on the owner. Without D-M26-1 A and D-M26-2 A, Z cannot reach 45 in M2
  (intake §2). A1-A3, V, S, AC, LH, AR, PT, VP and N do not wait on any decision.
- Locks the coordinator holds: `F/test/rawRenderingAllowList.ts` (V, SD and Z, plus every M2.3/M2.5 slice) and
  `F/components/rendering/SourceView*` (SD and any M2.3/M2.5 slice).
- Risks R-a to R-f: intake §5. Highest: the permanent-link redirect (R-b) and the first UI acceptance spec (R-d).

## Ruled out
- Editing `routes.test.ts` and the gallery maps in every slice: guaranteed conflicts (F5, F7). A1 and A3 replace that.
- A redirect per account or org-settings section: about 40 link edits across areas (F15). Optional segments keep the
  old addresses valid.
- Renaming URLs together with the UI text in each area slice: `/cases` and `/jobs` are linked from 50 files, so the
  renames are serial (UP, UR).
- Opening the verifier API to anonymous callers inside M2.6: that is a visibility and contract change (D-M26-4 B,
  CRP).
- Global Problems and Studies lists: +2 screens against a budget with no slack (D-M26-5).

## Next three steps
1. Coordinator: start S0a-S0e now. Start A2 now. Start A1 as soon as M2.4 slice 5 merges, and A3 after A1.
2. Coordinator: send D-M26-1 to D-M26-7 (intake §4) to the owner as one decision request with the recommendations.
   Ask the M2.3 and M2.5 planners to finish offenders 8, 9, 12 and 15 early, because SP, OS and PP wait on them.
3. When A1-A3 merge and each T-x is frozen, start wave 1 (V, S, AC, LH, AR, PT, VP) in parallel, at most two checks
   at a time in the lab. Then waves 2 and 3, then UP → UR → Z serially.

## Evidence
- Planning task on 00f653ef. Facts with file:line are in intake.md §1. No lookups were needed.
- Checks: none registered for this task; none run.
