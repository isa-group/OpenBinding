# Intake: m26-navigation (ROADMAP M2.6)

- Owner request: own-a88d098d12d0454793fb64673a109fbe (27-10-2026). Plan M2.6: the navigation and project tabs of
  ARCHITECTURE §5.2, the Problem/Run vocabulary of INTENT §5, the Verify page (resolve and verifier, offender 6) and the
  development-only system-states screen. Slice it into changes of one capability each, with disjoint files and tests
  first. Mark the slices that can run in parallel and the dependencies on M2.3 and M2.5.
- The body file named in the brief, `docs/agent-work/inbox/2026-10-27-own-a88d098d12d0454793fb64673a109fbe-add_request.md`,
  is not in the worktree (`docs/agent-work/inbox/` does not exist). This plan uses the brief text, `ROADMAP.md:71` and
  the documents cited below.
- Written 2026-10-27 at worktree head `00f653ef`. The planner writes only `docs/agent-work/m26-navigation/**`. The
  slices, owned files, checks and order are in [handoff.md](handoff.md).

## 1. Verified facts (file:line at 00f653ef)

### Roadmap, intent and architecture
- F1. `ROADMAP.md:71`: M2.6 delivers the navigation and project tabs of §5.2, the Problem/Run vocabulary, the Verify page
  (resolve and verifier, offender 6) and a development-only system-states screen. Acceptance: the e2e route smoke is
  green, old URLs redirect, the allow-list is empty, and there are at most 45 routed screens.
- F2. `ROADMAP.md:68` (M2.3: offenders 1-4) and `:70` (M2.5: offenders 8-10, 12-15) have no recorded progress
  (`:75-79`), and `openspec/changes/` has no M2.3 or M2.5 change. M2.4 slice 5 (sponsorship) is under review. It edits
  `frontend/src/routes/{routes.test.ts,retiredRoutes.tsx,retiredRoutes.test.tsx,d8.tsx}` and
  `frontend/e2e/s9a-admin.spec.ts` (`openspec/changes/m24-retire-sponsorship/tasks.md`).
- F3. `docs/ARCHITECTURE.md:215-232` (§5.2) defines the target navigation:
  - Public: Home · Explore · Engines · Language · Pricing · Verify · About · Log in / Sign up.
  - Signed in: Home · Problems · Lab (Runs · Studies · Generator) · Engines · Language · Admin; "+ New" (problem,
    collection, study, run); the account menu (Profile · Plan · API keys · Identities · Notifications).
  - Project: Overview · Problems · Collections · Runs · Studies · Published · Settings (General · Members).
  - Problem page: tabs Overview · Runs · Versions · Source · Settings. Study page: Setup · Progress · Results · Publish.
  - Budget: at most 45 routed screens, counted on the route registry.

  `:258-264`: `<pre>` and `JSON.stringify` output are allowed only inside `SourceView` and `LogPanel`. `VerifyResult`
  is the Verify component, and `ROADMAP.md:72` schedules it in M2.7.
- F4. `INTENT.md:104-124` (glossary): the UI says Problem, Problem version, Run, Study run and Published result. API
  `v1` keeps `cases`, `jobs` and `publications`. `INTENT.md:245` (D1): the vocabulary defaults to yes.
  `:143`: resolve and verifier merge into one Verify page. `:147`: Examples merge into Explore. `:137`: snapshots and
  project files are hidden ("no Files page"). `:151`: the system-states screen is development only. `:173` (O12): at
  most 45 routed screens, and each journey takes at most five screens. `:48-49` (journey 1): a reader verifies a digest
  without an account. `:87` (principle 5): permanent links survive renames and moves. `:234-235` (§11.10): changing a
  `ROADMAP.md` milestone needs a CRP. `:226` (§11.3): so does a visibility rule.

### Route registry and redirects
- F5. `frontend/src/routes/registry.ts:12-23`: there are eight route files, `d1.tsx` to `d8.tsx`, one per prototype
  domain. `routes.test.ts:9-53,63-66` pins all 69 ids and paths and the size of each domain, in one file.
- F6. `retiredRoutes.tsx:81-95` holds the 13 M2.4 redirects. `index.tsx:51-59` renders them only inside the
  `ProtectedRoute` application layout, so there is no redirect mechanism for a public address (for example
  `/resolve/...`). `links.test.ts:60-80` fails when a source literal links to a retired path.
- F7. The e2e smoke and the QA gallery read `live('id', '/path'` lines from `d1..d8`
  (`e2e/routes-smoke.spec.ts:8-28`, `e2e/helpers/galleryRoutes.ts:3-7,66-67`). The gallery keeps one map of titles and
  queries per screen id (`e2e/qa-gallery.spec.ts:45,84`, `galleryRoutes.ts:60`). Every slice that changes a screen
  edits these shared files.
- F8. `.agentic/project.yaml:106-108`: `frontend/src/routes/**` is in R1 (high). Other `.tsx`, `.css` and
  `frontend/e2e/**` files are in R9 (medium, `:131-133`). Panels are at `:141-147`.

### Screens in scope
- F9. Verify:
  - `d1.tsx:28` registers `pub-resolve` `/resolve/:kind/:digest` (public). `d6.tsx:28` registers `verifier`
    `/app/verifier` (account required).
  - `pages/Reports/Verifier.tsx:175-180` shows the canonical JSON in a `<pre>`. That is offender 6
    (`test/rawRenderingAllowList.ts:72-78`, `retiredBy: 'M2.6'`).
  - `Verifier.tsx:119,134` links to `/resolve/...`. Publication payloads carry
    `https://…/resolve/report/<digest>` as their citation URI (mirrored in `e2e/helpers/mockApi.ts:353-364`), so
    `/resolve/:kind/:digest` is a published permanent link.
  - `openspec/specs/resolver-verifier/spec.md:39-49` (`req~resolver-verifier-inspect-auth~1`): an anonymous call to
    the verifier gets 401. `:15-25`: resolve is public and does not leak private elements.
- F10. System states: `d1.tsx:23,43` registers `sys-states` for every build. `src/` never reads
  `import.meta.env.DEV/PROD`. The mocked Playwright project runs the Vite dev server (`playwright.config.ts:39-40`),
  where `DEV` is true, so `e2e/s2-auth.spec.ts:491-494` and the gallery entry (`qa-gallery.spec.ts:45`) keep working
  for a development-only screen. `frontend/.gitignore:11` ignores `dist`.
- F11. Signed-in header:
  - `components/PlatformShell/AppHeader.tsx:112-136` shows Home · Jobs · Explore · a Tools menu (Verifier, Engine
    catalog, My engines, Language extensions, Generator lab, Language docs) · Admin
    (`appNavigation.ts:14-28`).
  - New menu (`appNavigation.ts:80-98`): Organization, Project, Case, Job, Study, API key, Engine.
  - Account links (`:30-35`): Account, "Plan & permissions", API keys, Notifications. Identities is missing.
- F12. Public header: `components/Navigation/Navigation.tsx:86-112` shows Explore · Engines · a Language menu
  (Profiles & dialects, Schemas, Examples, Workbench) · Pricing · About. Verify is missing.
- F13. `components/PlatformShell/ProjectTabs.tsx:20-33`: the tabs are Overview · Cases · Collections · Jobs · Studies
  · Publications · Files, plus Package and Settings. Visibility per tab comes from `utils/accessLevel.ts`
  (`canOpenSection`).
- F14. Layouts already shared by sections: `pages/Account/AccountLayout.tsx` (6 account screens) and
  `pages/Organization/OrgSettingsLayout.tsx` (settings, members, audit).
- F15. Vocabulary scale:
  - the words Case(s) and Job(s) appear in 69 non-test source files (155 matches);
  - `/cases` and `/jobs` path literals appear in 50 files (186 matches);
  - `/app/account/<section>` is linked from 28 files, and org settings and creation addresses from 14.

  `pages/System/States.tsx` and `pages/AppHome/AppHome.tsx` link to almost every area.
- F16. Allow-list: `test/rawRenderingAllowList.ts:24`, `MAX_ALLOWED_OFFENDERS = 12`. Entries by slice: M2.3 (1-4),
  M2.5 (8, 9, 10, 12, 13, 14, 15) and M2.6 (6). `UNLISTED_FINDINGS` (`:140-148`) holds offender 16,
  `pages/Workbench/SourcePanel.tsx:108` (a diff in `<pre>`), and no slice owns it. `SourceView` is in
  `components/rendering/SourceView.tsx`.
- F17. Files of M2.3 and M2.5 (from the allow-list):
  - M2.3: `components/EngineReportView/**`, `pages/Jobs/JobResult.tsx`, `pages/Workbench/{RunPanel,CheckResult}.tsx`.
  - M2.5: `pages/Studies/{StudyCell,StudyDetail}.tsx`, `pages/Engines/EngineParts.tsx`,
    `pages/Organization/OrgAudit.tsx`, `pages/RegisterEngine/EngineForm.tsx`, `pages/Generator/LabAside.tsx`,
    `pages/Cases/SnapshotDetail.tsx`.

  Both also edit `test/rawRenderingAllowList.ts`.
- F18. The UI acceptance runner (`frontend/playwright.acceptance.config.ts`, `testDir ../acceptance/ui`) has no spec
  yet. Whether a spec outside `frontend/` resolves `@playwright/test` is unproven
  (`openspec/changes/archive/2026-10-26-m03-gate-tooling/design.md:251`). The first M2.6 test-designer task proves it.

## 2. Screen budget: 69 today, 45 required (F1, F5)

"Merge (section)" means the screen becomes a section or tab of one routed page. The page has one registry entry with
an optional trailing segment (`/app/account/:section?`), so the old address stays valid and needs no redirect. This
counting rule is decision D-M26-1.

| # | Screens removed from the production registry | How | Δ | Left | Slice |
|---|---|---|---|---|---|
| 1 | pub-resolve + verifier → `verify` `/verify/:kind?/:digest?` | merge; `/resolve/...` and `/app/verifier` redirect | −1 | 68 | V |
| 2 | sys-states | development builds only | −1 | 67 | S |
| 3 | acct-usage, acct-keys, acct-key-new, acct-identities, acct-notifications | sections of `acct-profile`; new key as a dialog | −5 | 62 | AC |
| 4 | org-members, org-audit | sections of `org-settings` | −2 | 60 | OS |
| 5 | proj-files, proj-package | Files retired (INTENT :137); package export moves into Settings › General | −2 | 58 | PT |
| 6 | study-run, study-analytics, study-cell | the study page gets a run selector and tabs; a cell opens its run | −3 | 55 | SP |
| 7 | case-revision, case-compare, snap-detail | problem page with a version selector and Versions/Source tabs | −3 | 52 | PP |
| 8 | lang-schemas, lang-extensions | sections of the Language hub | −2 | 50 | LH |
| 9 | lang-examples | a section of Explore (INTENT :147); M3.8 makes it a collection | −1 | 49 | EX |
| 10 | pub-status | retired (no journey, not in §5.2) | −1 | 48 | RS |
| 11 | auth-reset-complete | one password-reset screen; the token is read from the query | −1 | 47 | AR |
| 12 | org-create, proj-create | dialogs from Home, the organization page and "+ New" | −2 | 45 | CD |

Reserve, if one row fails: `job-launch` becomes a "New run" dialog on the problem page and the project Runs tab (−1).
`admin-errors` folds into "queues and engine health" (−1; ARCHITECTURE §5.3 still names "admin errors").

If tabs and sections count as separate screens (D-M26-1 option B), rows 3, 4, 6 and 7 save 7 screens instead of 13.
The registry then ends near 53, and 45 is reachable only after M3.2/M3.3/M3.6/M3.7 (D-M26-2).

## 3. Consequences for the plan

1. **Foundations first (wave 0).** Each later slice must own its own route file, its own expectations and its own
   gallery entries. A1 splits the registry by area, adds a redirect mechanism that also covers public addresses and
   splits the tests per area. A2 adds address builders per area and makes the hub files (header, palette, tabs,
   footer, AppHome, States) use them. A3 makes the smoke and the gallery read the new files. A1 and A2 can run in
   parallel. A3 follows A1.
2. **Old addresses.**
   - A merged section keeps its address (optional segment), so it needs no redirect.
   - A screen that goes away or changes shape gets an entry in its area's redirect table.
   - `/resolve/:kind/:digest` stays the published permanent-link format. It redirects to Verify forever, and its
     redirect entry is marked `permanent` so `links.test.ts` still allows links to it (F9).
3. **Verify does not change the API (D-M26-4 option A).** Signed out, a digest is looked up through the public
   resolve endpoint, and checking a document or a file asks the visitor to log in. Signed in, the page uses the
   verifier as today. The canonical JSON goes into a collapsed `SourceView`, which removes offender 6. `VerifyResult`
   stays in M2.7.
4. **System states:** `live(..., { devOnly: true })`. The production registry, which the budget counts, drops it. The
   lazy import is behind the `import.meta.env.DEV` check, so the production bundle does not contain the screen.
5. **The vocabulary moves in three passes:**
   - UI text per area: VP for problems, VR for runs. PT and N rename the labels of the tabs and the header.
   - URLs: UP renames `cases` to `problems`; UR renames `jobs` to `runs` and `/app/jobs` to `/app/runs`. Both are
     serial because they edit link literals in many files (F15).
   - The final sweep (Z) adds a vocabulary assertion to the route smoke.

   API types and calls keep `cases` and `jobs` (F4). No feature flag: each slice leaves its own screens consistent.
   The develop preview mixes vocabularies for a few days, and R1 is not cut before Z.
6. **Dependencies on M2.3 and M2.5** (F17):
   - SP waits for M2.5 offenders 8 and 9. OS waits for offender 12. PP waits for offender 15.
   - VR and UR wait for all of M2.3, because `pages/Jobs/**` is rewritten there.
   - VP may run beside M2.3 and M2.5 but must not touch the files listed in F17.
   - Z needs M2.3 and M2.5 merged, because the allow-list must be empty.
   - `test/rawRenderingAllowList.ts` has one writer at a time: V, SD and the M2.3/M2.5 slices take turns (coordinator
     lock).
7. **Tests first.** Each change with visible behaviour gets a test-designer task. It writes
   `acceptance/ui/navigation/<slug>.spec.ts` from the change's spec, and a red-before check (gate G3) proves the spec
   fails on the base commit. The implementer adds unit tests before the code. A1, A2, A3 and S have no new visible
   behaviour, so they use characterization or unit tests first plus the checks in the handoff.

## 4. Decisions requested (owner, via CRP; each with a recommendation)

- **D-M26-1: how the 45-screen budget is counted** (INTENT O12, ARCHITECTURE §5.2: "a test counts the route registry").
  - **A, recommended:** one routed page with sections or tabs (problem page, study page, account, organization
    settings, Language hub) counts as one screen. It has one registry entry with an optional section segment. This
    matches §5.2, which describes those pages as single pages with tabs.
  - B: every section counts. Then 45 is not reachable in M2 (section 2).
- **D-M26-2: problem-page tab shell in M2.6** (ROADMAP §11.10 for any change of milestone acceptance).
  - **A, recommended:** M2.6 builds the problem page's tab frame from the existing views (case detail, revision,
    compare, compiled form). M3.2/M3.3 fill it with the new components.
  - B: keep the problem page in M3 and move "≤ 45 routed screens" from M2.6 to M3.3. The M2.6 target becomes ≤ 48.
- **D-M26-3: retire the public `/status` page.** It is not in §5.2 and no journey needs it (principle 12).
  - **A, recommended:** retire it and redirect to `/about`, which gains a one-line service-status note.
  - B: keep it. Then the reserve row is needed.
- **D-M26-4: Verify for visitors without an account** (INTENT §11.1/§11.3, `req~resolver-verifier-inspect-auth~1`).
  - **A, recommended:** no API change. Visitors verify digests and permanent links, and checking a document or a file
    needs an account.
  - B: open `POST /v1/verifier/inspect[-file]` to anonymous callers, with rate limits. That is a contract and
    security change in the gateway, outside M2.6.
- **D-M26-5: top-level "Problems" and "Lab › Studies"** (§5.2), which have no global list today.
  - **A, recommended:** both open the current project's tab. Without a project they are disabled with the hint "Needs
    a project", like the New menu today (`appNavigation.ts:84-95`). No new screens are added. Global lists can come
    with M3.5 or M8.1.
  - B: add two global list screens (budget +2, which needs the reserve).
- **D-M26-6: rename URLs as well as UI text:** `cases` → `problems`, `jobs` → `runs`, `/app/jobs` → `/app/runs`,
  `publications` → `published`. Old addresses redirect, and API paths are unchanged.
  - **A, recommended:** yes, in M2.6 (UP, UR and PT).
  - B: UI text only. The URLs change with M3.5 (`/p/{id}`).
- **D-M26-7: unlisted offender 16** (`Workbench/SourcePanel.tsx:108`, a diff in `<pre>`).
  - **A, recommended:** slice SD shows the diff through `SourceView` (a diff mode) so the allow-list can be empty.
  - B: owner exempts the diff of the editor's source panel and records it in the hygiene test.

## 5. Risks

- R-a: shared test files. Before A1 and A3, every slice edits `routes.test.ts` and the gallery maps. Mitigation:
  wave 0 goes first, and A1 starts only after M2.4 slice 5 merges (F2).
- R-b: permanent links. A broken `/resolve/...` redirect breaks journey 1 and published citations. V carries a
  redirect test for every resolve kind, signed in and signed out. Risk is high (R1).
- R-c: link literals across areas (F15). The redirect slices update the link lines in other areas' files. The
  coordinator checks that the files listed under "cross-area links" are not held by a running slice.
- R-d: the first UI acceptance spec (F18). If `@playwright/test` does not resolve from `acceptance/ui`, the
  test-designer reports it, and an implementer task owning `frontend/playwright.acceptance.config.ts` fixes it before
  any G3 check.
- R-e: the 45 target leaves no slack (section 2). Z fails if one row slips. The reserve is listed, and D-M26-1/2/3
  decide it.
- R-f: M2.7 will touch the same pages for identity labels. M2.6 does not change identity labels, to avoid churn.
