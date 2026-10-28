# Design: m26-navigation

The fixed inputs are:
- ROADMAP M2.6 and ARCHITECTURE §5.2 and §5.3;
- INTENT §5 (glossary), §6 and O12;
- the owner's decisions D-M26-1 to D-M26-7, option A of each (`docs/agent-work/m26-navigation/intake.md` §4);
- the registry today: 69 screens in `d1.tsx` to `d8.tsx`;
- the allow-list today: offender 6 and the unlisted finding 16, with `MAX_ALLOWED_OFFENDERS` 1. M2.3 and M2.5 have
  merged, and their offenders are gone.

## 1. Context

- `routes/registry.ts` concatenates eight prototype-domain files. `routes.test.ts` pins every id, path and domain size
  in one file, so every slice would edit it.
- `RETIRED_ROUTES` (M2.4) is mounted only inside the signed-in application layout. A public old address such as
  `/resolve/...` has no redirect mechanism.
- The gateway emits frontend addresses, and this change leaves the gateway as it is:
  - `services/citations.py`: `citation.url` is `/resolve/<kind>/<digest>`, or `/app/verifier?digest=<digest>` without
    a resolvable kind;
  - `routes/resolve.py` (`web_url`): `/app/<org>/<project>/cases/<case>/revisions/<n>`,
    `/app/<org>/<project>/files` and `/app/<org>/<project>/snapshots/<id>`;
  - `routes/auth.py`: `/password-reset/complete` in the reset e-mail.

  These addresses must keep working with no end date.
- `SourceView` (`components/rendering/SourceView.tsx`) takes a string `source`, a `label` (the region name and
  `Copy <label>`) and an optional `language`. That covers the canonical JSON of Verify and the workbench diff, so
  `SourceView` does not change. `components/rendering/**` is M2.7's.

## 2. Areas and the screen budget

| Area | Screens after M2.6 | Count | Leaves the production registry |
|---|---|---|---|
| public | `pub-home` `/`, `pub-explore` `/explore/:section?`, `pub-about` `/about`, `pub-pricing` `/pricing` | 4 | `pub-status` (retired) |
| auth | `auth-login`, `auth-register`, `auth-reset-request` `/password-reset`, `auth-cas-callback`, `org-invite-accept` | 5 | `auth-reset-complete` |
| verify | `verify` `/verify/:kind?/:digest?` | 1 | `pub-resolve`, `verifier` (merged) |
| system | `sys-states`, development builds only | 0 | `sys-states` (production) |
| language | `lang-profiles` `/language/:section?/:item?` | 1 | `lang-schemas`, `lang-extensions` (sections); `lang-examples` (to Explore) |
| engines | `eng-catalog`, `eng-detail`, `eng-register`, `eng-registrations`, `eng-registration-detail` | 5 | — |
| account | `acct-profile` `/app/account/:section?` | 1 | `acct-usage`, `acct-keys`, `acct-key-new`, `acct-identities`, `acct-notifications` |
| organizations | `app-home` `/app`, `org-overview` `/app/:org`, `org-settings` `/app/:org/settings/:section?` | 3 | `org-members`, `org-audit` (sections); `org-create` (dialog) |
| project | `proj-overview`, `proj-settings` `/app/:org/:project/settings/:section?`, `proj-publications` `/app/:org/:project/published` | 3 | `proj-files`, `proj-package` (retired); `proj-create` (dialog) |
| problems | `case-list` `/app/:org/:project/problems`, `case-detail` `/app/:org/:project/problems/:case/:tab?`, `wb-workbench`, `pub-workbench` | 4 | `case-revision`, `case-compare`, `snap-detail` |
| collections | `coll-list`, `coll-detail` | 2 | — |
| runs | `job-launch` `…/runs/new`, `job-list` `…/runs`, `job-detail` `…/runs/:job`, `job-history` `/app/runs`, `gen-lab` | 5 | — |
| studies | `study-list`, `study-builder`, `study-detail` `/app/:org/:project/studies/:study/:tab?` | 3 | `study-run`, `study-analytics`, `study-cell` |
| admin | the eight `admin-*` screens | 8 | — |
| **Total** | | **45** | 24 |

Before the change the areas count 5, 6, 2, 1, 4, 5, 6, 6, 6, 7, 2, 5, 6 and 8, which is 69. Slice 1 moves the screens
without changing them. Each later slice lowers the ceiling of the budget test to the count it reaches, and slice 15
pins `≤ 45`.

Reserve, in case one row slips: `job-launch` becomes a "New run" dialog (−1), and `admin-errors` folds into the
queues screen (−1). Neither is planned.

## 3. Moved-routes table (final state)

"Kept" means the query and the hash are carried over to the target. "Perm." marks an entry as `permanent`: it is never
removed, and the link scan allows links to it.

| Area | Old address | Target | Query / hash | Perm. | Why permanent |
|---|---|---|---|---|---|
| verify | `/resolve/:kind/:digest` | `/verify/<kind>/<digest>` | kept | yes | published citations, `citation.url` |
| verify | `/app/verifier` | `/verify` | kept (`digest`) | yes | `citation.url` without a kind |
| public | `/status` | `/about` | dropped | no | |
| language | `/examples` | `/explore/examples` | kept | no | |
| language | `/app/language/extensions` | `/language/extensions` | kept | no | |
| auth | `/password-reset/complete` | `/password-reset` | kept (`token`) | yes | reset e-mail of the gateway |
| account | `/app/account/keys/new` | `/app/account/keys?create=key` | dropped | no | |
| organizations | `/app/organizations/new` | `/app?create=organization` | dropped | no | |
| project | `/app/:org/new-project` | `/app/<org>?create=project` | dropped | no | |
| project | `/app/:org/:project/files` | `/app/<org>/<project>` | dropped | yes | resolve `web_url` |
| project | `/app/:org/:project/package` | `/app/<org>/<project>/settings` | dropped | no | |
| project | `/app/:org/:project/publications` | `/app/<org>/<project>/published` | kept | no | |
| problems | `/app/:org/:project/cases` | `…/problems` | kept | no | |
| problems | `/app/:org/:project/cases/:case` | `…/problems/<case>` | kept | no | |
| problems | `/app/:org/:project/cases/:case/revisions/:revision` | `…/problems/<case>?version=<revision>` | dropped | yes | resolve `web_url` |
| problems | `/app/:org/:project/cases/:case/compare` | `…/problems/<case>/versions` | kept (`from`, `to`) | no | |
| problems | `/app/:org/:project/snapshots/:snapshot` | `…/problems` | dropped | yes | resolve `web_url` |
| runs | `/app/jobs` | `/app/runs` | kept | no | |
| runs | `/app/:org/:project/jobs` | `…/runs` | kept | no | |
| runs | `/app/:org/:project/jobs/new` | `…/runs/new` | kept | no | |
| runs | `/app/:org/:project/jobs/:job` | `…/runs/<job>` | kept | no | |
| studies | `…/studies/:study/runs/:run` | `…/studies/<study>/progress?run=<run>` | dropped | no | |
| studies | `…/studies/:study/runs/:run/analytics` | `…/studies/<study>/results?run=<run>` | dropped | no | |
| studies | `…/studies/:study/runs/:run/cells/:cell` | `…/studies/<study>/results?run=<run>&cell=<cell>` | dropped | no | |

Every target segment is encoded with `encodeURIComponent`.

Some old addresses need no entry because the optional section segment keeps them valid:
- account `usage`, `keys`, `identities` and `notifications`;
- organization settings `members` and `audit`;
- Language `schemas/<kind>`.

The study and problem tab addresses are new.

### Mounting

- Moved routes sit in a pathless parent route outside `ProtectedRoute`, after the screens. A screen wins on a tie
  of rank, as in M2.4.
- The redirect needs no session, so a public visitor following a published `/resolve/...` link, or the gateway's
  `/app/verifier?digest=` link, never sees `/login`. An `/app` target keeps its guard. `state.from` then names the
  target, not the old address.
- `RETIRED_ROUTES` stays behind the guard. Three of its targets become moved addresses:
  - `…/publications` (the reports rule), in slice 5;
  - `…/studies/<s>/runs/<r>` (the decision-space rule), in slice 8;
  - `/app/jobs` (the decision-space rule), in slice 14.

  The slice that moves an address also points the retired target at the new address. Every retired redirect then
  stays one hop, and its target stays a routed screen, as `req~frontend-retire-redirect-generic~1` requires. That
  slice updates `routes/retiredRoutes.tsx` and its tests, and the archive records the new target values (§7).

### Tie checked

Three addresses each match `org-settings` (as an unknown section) and a moved project entry (with the project
`settings`):
- `/app/<org>/settings/files`;
- `/app/<org>/settings/package`;
- `/app/<org>/settings/publications`.

Both routes have two static and two dynamic segments, so they have the same rank. The screen wins, as the mounting
rule says, and the organization settings page shows `Page not found` for the unknown section. Today these addresses
open sections of a project named `settings`, a project that the organization settings already shadow at
`/app/<org>/settings`.

## 4. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Redirect table | One `redirects` list per area file, concatenated into `MOVED_ROUTES`. Each entry is `{ id, path, target(query, params) → string, keep: 'all' \| 'none', permanent?: true }`. The hash is appended when `keep` is `'all'` | Growing `RETIRED_ROUTES`: it is guarded and app-only, and its rows are pinned by unarchived M2.4 requirements |
| Guard on moved routes | None; the target's guard applies | Behind the guard as in M2.4: a signed-out reader of a citation link would have to log in, against journey 1 |
| Sections | One optional trailing segment (`:section?`, `:tab?`), plus `:item?` for Language schemas. An unknown segment renders `Page not found` | A redirect per section (about 40 link edits across areas, ruled out in the handoff); a query `?tab=` (breaks the existing section addresses) |
| Language schemas | `/language/:section?/:item?`, so `/language/schemas/<Kind>` stays valid | Redirect to `?kind=`: the Home and Profiles screens link many schema addresses |
| Dialog addresses | The query `create=<kind>` opens a creation dialog (`organization`, `project`, `key`, `problem`, `collection`). Closing it removes the query | Dialog state only in memory: old creation addresses could not land on an open dialog |
| Package screen | Both its Export and Import sections move into Settings › General | Export only, as the owner's summary says: dropping Import would lose a function nobody decided to retire. M3.7 moves both onto the problem and collection pages |
| Project Members | Lists the members of the project's organization, who are the people with project access, and links `Manage members` to the organization settings | No section: §5.2 names Settings (General · Members); a project-members API: none exists |
| Study Publish tab | The selected study run's CSV export (moved from analytics) and a link to the project's Published tab | An empty tab until M6.5 |
| Snapshot address | To the project's Problems tab; the snapshot id is dropped | Looking up the snapshot's problem version on arrival: a client-side search over all problems; the address is a hidden internal concept (INTENT §6) |
| Problem version address | `…/problems/<case>?version=<n>`, which opens the Overview of version n | A `versions/<n>` segment: a second optional segment for one tab |
| Ids and parameters | Screen ids, route parameter names and query names stay (`case-detail`, `:case`, `:job`, `?case=`) | Renaming them: churn in the gallery, tests and pages for no visible gain |
| Verify kinds signed out | A kind selector when the address or the pasted link names none | Probing all ten kinds: ten requests per lookup |
| Vocabulary check | A source scanner (`src/test/vocabulary.ts`) for text in JSX and labels, plus the route smoke on rendered text, with exemptions for `code`, `SourceView` and `LogPanel` | The smoke only: slow feedback. The scanner only: misses composed text |
| Feature flag | None. Each slice leaves its own screens consistent. The preview mixes vocabularies until slice 12 | A flag per area: dead code in the 45-screen count |

## 5. Verify page

| Input | Signed out | Signed in |
|---|---|---|
| `/verify/<kind>/<digest>`, or a pasted permanent link | `GET /v1/resolve/{kind}/{digest}` | the same |
| `/verify?digest=`, or a digest typed without a kind | kind selector, then `GET /v1/resolve/...` | `POST /v1/verifier/inspect` with the digest |
| Document | `Log in to check a document or a file` | `POST /v1/verifier/inspect` |
| File | the same text | `POST /v1/verifier/inspect-file` |

- The result views are those of today's `pages/Resolve` and `pages/Reports/Verifier`, moved to `pages/Verify/`.
  `VerifyResult` (M2.7) replaces them later.
- The canonical JSON goes into `<details>` with the summary `Canonical JSON`, around
  `<SourceView source={canonical_json} label="Canonical JSON" language="json" />`.
- The copy action keeps the `/resolve/<kind>/<digest>` form.
- `verifierOptions` and its tests move along with the page.

## 6. Vocabulary passes

| Pass | Slice | Words or segments |
|---|---|---|
| Text of the screens that a slice rebuilds | 2, 3, 4, 8 | Verify kind names (`case-revision` reads `Problem version`); account usage (`Runs that may run at once`); Explore and the public home (`Published results and public projects`); the studies text |
| Labels of the shell and the tabs | 5, 11 | Problems, Runs, Published, New menu |
| Text of the problem area | 10 | Case(s) → Problem(s), revision of a problem → version |
| Text of the run area, then the rest | 12 | Job(s) → Run(s), publication → published result, in `pages/Jobs/**`; then every other file that the scanner reports, such as `pages/Admin/**` (`Jobs by state`, `Job queue`, `Reconcile jobs`), `pages/Engines/**`, `pages/Generator/**` and `pages/Platform/**` |
| Addresses: `cases` → `problems` | 13 | the builders of `routes/paths/problems.ts`, every link literal |
| Addresses: `jobs` → `runs` | 14 | the builders of `routes/paths/runs.ts`, every link literal |
| Final assertion | 15 | the route smoke rejects the words of `req~frontend-nav-vocabulary-text~1` |

Some organizations may already use a slug that the new static addresses shadow. `/app/runs` shadows an organization
named `runs`, as `/app/jobs` shadows `jobs` today. Slice 14 adds `runs` to the frontend's reserved organization slugs.

## 7. Reconciliation with earlier changes (at the archive)

These changes are merged but not archived, so this delta cannot MODIFY their requirements. The archive of
`m26-navigation` runs after the M2.4 and M2.5 archives. It turns each row below into a REMOVED or MODIFIED entry, or
updates the pinned value.

| Requirement | Pinned today | After M2.6 |
|---|---|---|
| `req~frontend-retire-reports-publications-stay~1` | `proj-publications` at `/publications`, `verifier` at `/app/verifier` stay routed | REMOVED: `verify` and `/published` replace them |
| `req~frontend-retire-reports-navigation~1`, `req~frontend-retire-library-navigation~1` | project tab labels with `Cases`, `Jobs`, `Publications`, `Files`, `Package` | superseded by `req~frontend-nav-project-tabs~1` |
| `req~frontend-retire-navigation~1`, `req~frontend-retire-palette~1` | header links `/app/jobs`, the Tools menu | superseded by `req~frontend-nav-signed-in-navigation~1` |
| `req~frontend-retire-redirect-decision-space~1`, `req~frontend-retire-reports-redirect~1` | targets `/app/jobs`, `…/publications`, `…/studies/<s>/runs/<r>` | targets `/app/runs` (slice 14), `…/published` (slice 5), `…/studies/<s>/progress?run=<r>` (slice 8) |
| `req~frontend-retire-redirect-generic~1`, scenario "Every target is a routed screen" (`retiredRoutes.test.tsx`) | targets resolve to `job-history` at `/app/jobs`, `study-run` and `proj-publications` at `/publications` | `job-history` at `/app/runs`, `study-detail`, and `proj-publications` at `/published`; updated in slices 14, 8 and 5 |
| `req~frontend-retire-composer-redirect~1`, scenario "Neighbouring case screens keep their addresses" (`retiredScreens.test.tsx`) | `…/cases/<c>/compare` and `…/revisions/2` resolve to `case-compare` and `case-revision` | they redirect to the problem page (slice 9) |
| The domain lists and sizes of M2.4 (`*-screen-not-routed~1`, `*-screens-not-routed~1`, `*-screen-count~1`; for example the D4 lists of `m24-retire-composer` and `m24-retire-screens-3`) | the D1 to D8 lists and sizes | the area lists and sizes (slice 1 on) |
| `req~frontend-retire-sponsorship-redirect~1`, scenario "Neighbouring administration screens" | `/app/organizations/new` resolves to `org-create` | it redirects to `/app?create=organization` |
| `*-screen-count~1` of M2.4 | 69 screens, domain sizes | `req~frontend-nav-screen-budget~1`, area sizes |
| `req~frontend-studies-source-tab~1` (M2.5) | the study page's Overview/Source tabs; the cell page's Result/Source tabs | the pair lives inside Setup, and the cell is shown inside Results |
| `req~frontend-snapshot-source-tab~1` (M2.5) | the snapshot page's Source tab | the problem page's Source tab |
| living `req~frontend-workspace-client-guard~1`, scenario | returns to `/app/acme/demo/jobs?tab=failed` | returns to `/app/acme/demo/runs?tab=failed` (example only, no new meaning) |
| living `resolver-verifier` Purpose | "the `/app/verifier` screen" | "the Verify page `/verify`" |

The tests tagged with those requirements change in the slice that changes the behaviour, and the PR names the
superseded requirement.

## 8. Risks

- **Permanent links (high).** A broken `/resolve/...` redirect breaks journey 1 and every published citation.
  - Mitigations: a redirect test for each of the ten kinds, signed in and signed out; the `permanent` flag test; the
    route smoke visits every redirect.
- **Link edits across areas.** Slices 13 and 14 edit link literals in about 50 files. They run serially, after the
  slices that own those files have merged, and the address builders of slice 1 keep most edits to one line each.
- **The 45 target leaves no slack.** The reserve is in §2.
- **Gateway addresses.** Until a gateway follow-up emits the new addresses, the permanent entries carry that traffic.
  The snapshot entry lands on a list, not on the problem version.
- **Shadowed organization slugs** (`runs`), §6.
- **M2.7 touches the same pages** for identity labels. This change does not change identity labels.

## 9. Requirements and slices

Tests carry `[utest->req~<id>~1]` and code carries `[impl->req~<id>~1]`.

| Requirement | Slice | Main tests |
|---|---|---|
| `frontend-nav-route-areas`, `frontend-nav-redirects` | 1 | `routes/areas/*.test.ts`, `routes/movedRoutes.test.tsx`, `routes/links.test.ts` |
| `frontend-nav-verify-page`, `-verify-permanent-links`, `-verify-signed-out`, `-verify-no-raw-json` | 2 | `pages/Verify/*.test.tsx`, `routes/areas/verify.test.ts`, `e2e/s1a-public.spec.ts` |
| `frontend-nav-account-sections` | 3 | `pages/Account/*.test.tsx`, `routes/areas/account.test.ts` |
| `frontend-nav-language-hub`, `-examples-in-explore` | 4 | `pages/Profiles/*.test.tsx`, `pages/Public/Explore*.test.tsx` |
| `frontend-nav-project-tabs`, `-files-retired` | 5 | `components/PlatformShell/SectionNav.test.tsx`, `pages/Project/*.test.tsx` |
| `frontend-nav-org-settings-sections`, `-create-dialogs` | 6 | `pages/Organization/*.test.tsx`, `pages/AppHome/*.test.tsx` |
| `frontend-nav-system-states-dev-only`, `-reset-single-screen`, `-status-retired` | 7 | `routes/areas/{system,auth,public}.test.ts`, the NOSTATES check |
| `frontend-nav-study-page` | 8 | `pages/Studies/*.test.tsx` |
| `frontend-nav-problem-page` | 9 | `pages/Cases/*.test.tsx` |
| `frontend-nav-vocabulary-text` | 10, 12, 15 | `test/vocabulary.*.test.ts`, `e2e/routes-smoke.spec.ts` |
| `frontend-nav-public-navigation`, `-signed-in-navigation`, `-new-menu`, `-account-menu` | 11 | `components/PlatformShell/*.test.ts(x)`, `components/Navigation/*.test.tsx` |
| `frontend-nav-vocabulary-urls` | 13, 14 | `routes/areas/{problems,runs}.test.ts`, `test/vocabulary.urls.test.ts` |
| `frontend-nav-screen-budget`, `-allow-list-empty` | 15 (ceiling lowered from slice 1 on) | `routes/screenBudget.test.ts`, `test/rawRenderingHygiene.test.ts` |

## 10. Rollback

Each slice is one PR, reverted on its own. Reverting a slice restores its screens and removes its moved entries. A
permanent entry is never reverted on its own: reverting slice 2 restores `pub-resolve` at `/resolve/:kind/:digest`
itself. No data and no API is touched.

## 11. Requirement notes

These notes explain the requirements of the two deltas. The requirement statements and their scenarios are normative.

### Delta `frontend-workspace`

1. **Routes declared per area.**
   - The areas, in this order: `public`, `auth`, `verify`, `system`, `language`, `engines`, `account`,
     `organizations`, `project`, `problems`, `collections`, `runs`, `studies`, `admin`.
   - The route registry is the concatenation of their screen lists, and the moved-routes table is the concatenation of
     their redirect lists.
   - The prototype domain files `d1.tsx` to `d8.tsx` and `routesByDomain` go. §2 lists which screen belongs to which
     area.
2. **Moved addresses redirect.**
   - The table holds the redirect lists of every area, public and application addresses alike.
   - An entry has an id, the old path, a target computed from the path parameters and the query, and an optional
     `permanent` flag. The target keeps the query and the hash unless the entry's row in §3 drops them.
   - The redirect asks for no session, and the target keeps its own guard. A signed-out visitor sent to an `/app`
     address therefore sees `/login`, which remembers the target.
   - A routed screen wins over an entry that matches the same address with the same rank.
   - The M2.4 link scan applies to every entry. A source literal that links to an entry without `permanent` fails the
     suite. A link to a `permanent` entry is allowed, and a `permanent` entry is never removed.
   - The retired routes of M2.4 (`retiredRoutes.tsx`) stay a table of their own (§3).
3. **At most 45 routed screens.**
   - A screen is an entry of `routeDefinitions` in a production build. Moved addresses, retired routes and
     development-only screens are not screens.
   - A page with sections or tabs is one screen with one registry entry (D-M26-1). Its section segment is optional,
     so the old address of a section stays valid.
4. **System-states screen only in development builds.**
   - The screen is declared with a development-only flag in the `system` area.
   - The mocked Playwright project runs the development server, so the screen stays available to the browser tests
     and the QA gallery (INTENT §6).
5. **Account sections.**
   - The five section addresses stay what they were, so they need no redirect.
   - Creating an API key becomes a dialog of the API keys section, and `/app/account/keys/new` moves to
     `/app/account/keys?create=key`.
   - The account menu links the same five addresses.
6. **Creation dialogs.**
   - The workspace home offers `New organization`. The organization overview offers `New project` to the people who
     may create one there.
   - `/app/organizations/new` moves to `/app?create=organization`, and `/app/:org/new-project` to
     `/app/<org>?create=project`.
7. **Project tabs.**
   - The tabs lead to `/app/<org>/<project>`, and to `/problems`, `/collections`, `/runs`, `/studies`, `/published` and
     `/settings` under the project.
   - A visitor of a public project (`public_read`) sees no tab that only members can open (Runs and Settings), as
     today.
   - Members lists the members of the project's organization, who are the people with access to the project, and
     links to the organization's member settings.
   - `/app/:org/:project/publications` moves to `/published`.
8. **Files and Package retired.**
   - INTENT §6: "Snapshots and project files: hide ... no Files page". The project files list (upload, download and
     delete of project blobs) goes without a replacement.
   - `/files` moves to the project overview, and `/package` to the project settings.
   - M3.7 later moves import and export onto the problem and collection pages.
9. **Language hub.**
   - `/language/schemas/:kind` keeps its address as the Schemas section with the item segment.
     `/app/language/extensions` moves to `/language/extensions`.
   - Signed out, Extensions shows `Log in to see and manage language extensions` with a link to `/login`. Signed in,
     it shows the extension list and its actions, as the extensions screen did.
   - The hub links the public editor `/workbench`, which the public header no longer lists.
10. **Examples in Explore.**
    - INTENT §6: Examples merge into Explore as the public "BIM examples" collection, and M3.8 later turns them into a
      collection.
    - `/examples` moves to `/explore/examples` and keeps its query.
11. **Status retired.**
    - The status screen serves no journey and is not in ARCHITECTURE §5.2 (D-M26-3).
    - The About note reads `Service status: ` followed by the overall result of the gateway check that the status
      screen ran: `All systems operational`, `Degraded` or `Gateway reporting errors`. It reads
      `not available right now` when the gateway does not answer.
12. **One password-reset screen.**
    - `/password-reset/complete` moves to `/password-reset` and keeps the query.
    - The entry is `permanent`, because the gateway's reset e-mail links to it (`routes/auth.py`).
13. **Study page.**
    - The segments are `setup`, `progress`, `results` and `publish`. Without a segment, the page opens Setup when the
      study has no study run, and Progress otherwise.
    - The run selector lists the study runs, newest first, and sets `run`.
    - The tabs hold:
      - Setup: the study's configuration, and the M2.5 `Overview`/`Source` pair;
      - Progress: the study run's progress and cells;
      - Results: the study run's results, the former analytics. Selecting a cell (query `cell`) shows it inside
        Results, with its source and a link to its run, because a cell is a run (INTENT §6);
      - Publish: the study run's CSV export and a link to the project's published results. Publishing a study run is
        M6.5.
    - The study run, analytics and cell addresses move into the page (§3).
14. **Problem page.**
    - The segments are `runs`, `versions`, `source` and `settings`. No segment opens Overview.
    - D-M26-2: the tab frame is built now from the existing views, and M3.2 to M3.4 fill it.
    - The header holds the problem's name and a version selector that sets `version`.
    - The tabs hold:
      - Overview: what the problem and problem-version pages show today;
      - Runs: the problem's runs, newest first, each linking to its run page;
      - Versions: the history, and the comparison of two versions (`from`, `to`);
      - Source: the compiled form and the package files of the selected version, both in `SourceView`, as on today's
        snapshot page (M2.5);
      - Settings: the name and description, for the people who may change them.
    - A visitor of a public project sees no Runs tab and no Settings tab.
    - The version, compare and snapshot addresses move into the page (§3).
15. **Public navigation.**
    - ARCHITECTURE §5.2, Public. The `href` values are `/`, `/explore`, `/engines`, `/language`, `/pricing`, `/verify`,
      `/about`, `/login` and `/register`.
    - Language is one link to the hub, no longer a menu.
    - At phone width, the header button opens a menu with the same entries.
16. **Signed-in navigation.**
    - ARCHITECTURE §5.2, Signed in. The entries lead to:
      - Home: `/app`;
      - Runs: `/app/runs`;
      - Generator: `/app/generator`;
      - Engines: `/engines`;
      - Language: `/language`;
      - Admin: `/app/admin`.
    - Problems and Studies open the tab of the current project, the project of the header's switcher. Without a
      current project they are disabled with the hint `Needs a project` (D-M26-5).
    - The Tools menu goes:
      - the verifier becomes the public Verify page;
      - My engines is reached from Engines;
      - Language extensions are reached from the Language hub.
17. **New menu.**
    - With the current project at `<root>`, the items lead to:
      - `<root>/problems?create=problem` (the dialog `New problem`);
      - `<root>/collections?create=collection` (the dialog `New collection`);
      - `<root>/studies/new`;
      - `<root>/runs/new`.
    - Organizations and projects are created in dialogs, API keys in the API keys section, and engines from the Engines
      page.
18. **Vocabulary in the interface.**
    - INTENT §5: the interface says Problem, Problem version, Run, Study run and Published result. The HTTP API `v1`
      keeps `cases`, `jobs` and `publications`.
    - API paths shown in a `code` element are allowed.
    - The engine-registration screens keep `publication`. There it means listing an engine in the catalogue
      (`Request publication`), not a Published result.
    - Identity labels (names instead of digests) are M2.7's and do not change here.
19. **Vocabulary in addresses.**
    - D-M26-6. The old addresses move with the entries of §3.
    - The `v1` paths, the query names (the workbench's `case`) and the route parameter names do not change.
    - The permanent entries that the gateway still links redirect: `/cases/:case/revisions/:revision`,
      `/snapshots/:snapshot` and `/files`. No frontend source builds those addresses.
20. **Empty allow-list.**
    - ROADMAP M2.6 acceptance: "the allow-list is empty".
    - Offender 6 leaves with the Verify page.
    - The unlisted finding 16, the workbench source panel's diff in a `<pre>`, is shown through `SourceView` with its
      current label `Changes to <path>` (D-M26-7). `SourceView` itself does not change.

### Delta `resolver-verifier`

21. **One Verify page.**
    - INTENT §6: "Resolve and verifier: merge into Verify". The modes are `Link or digest`, `Document` and `File`
      (§5).
    - A kind and a digest in the address resolve through `GET /v1/resolve/{kind}/{digest}`, and the element is shown
      as the resolve screen shows it today.
    - A digest without a kind (query `digest`) is checked through the verifier when the person is signed in.
    - Documents and files go to `POST /v1/verifier/inspect` and `POST /v1/verifier/inspect-file`, which need an
      account (`req~resolver-verifier-inspect-auth~1`, unchanged; D-M26-4).
    - No gateway operation changes. The result views are those of today's screens, and `VerifyResult` is M2.7's.
22. **Permanent verification links.**
    - `/resolve/<kind>/<digest>` is the published permanent-link format. Publications cite it, and the gateway's
      `citation.url` points to it, or to `/app/verifier?digest=` for an element without a resolvable kind.
    - Both entries are `permanent` (INTENT principle 5). The Verify page keeps copying links in the
      `/resolve/<kind>/<digest>` form.
23. **Verify without an account.**
    - INTENT journey 1: a reader verifies a digest without an account.
    - The verifier still answers 401 to anonymous callers, so the signed-out page never calls it.
    - The kind selector lists the resolver's kinds. It appears when neither the address nor the pasted link names a
      kind.
    - A private element and an unknown digest look the same (`req~resolver-verifier-no-leakage~1`).
24. **Verify shows no raw JSON.**
    - This removes offender 6 (`pages/Reports/Verifier.tsx`, the canonical JSON in a `<pre>`). ARCHITECTURE §5.3
      allows `<pre>` and `JSON.stringify` output only inside `SourceView` and `LogPanel`.
    - `SourceView` is used as it is.
