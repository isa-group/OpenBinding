# Design: m24-retire-screens

Status: slice 1 built and in review; slices 2–5 are not specified. This file describes slice 1 (decision-space workspace) and the parts every slice
shares; slices 2–5 add their sections when they are specified. Fixed inputs: ROADMAP M2.4, ADR-0020 decisions 2, 3 and
5, INTENT D8, the route registry of `frontend/src/routes/` (82 screens, D6 with 12) and the allow-list of the change
`m21-rendering-catalogue` (15 offenders, two unlisted findings).

## 1. Context

Slice 1 retires two screens of domain D6, both declared in `frontend/src/routes/d6.tsx`:

| Id | Path | Page |
|---|---|---|
| `analysis-sources` | `/app/analysis` | `frontend/src/pages/Analysis/AnalysisSources.tsx` |
| `analysis-workspace` | `/app/analysis/workspace` | `frontend/src/pages/Analysis/AnalysisWorkspace.tsx` |

Links to them are written today in `pages/Jobs/JobDetail.tsx` (Analyze), `pages/Jobs/JobList.tsx` (Analyze N
selected), `pages/Jobs/JobHistory.tsx` (Analyze per row), `components/BindingAnalysis/BindingAnalysis.tsx` (Open
analysis), `pages/Studies/StudyAnalytics.tsx` (Weigh trade-offs), `pages/Reports/RepDetail.tsx` (Reopen decision
space), `components/PlatformShell/appNavigation.ts` (main entry Analysis and its section) and
`components/PlatformShell/paletteCommands.ts` (Go to Analysis). `RepDetail.tsx` also imports
`pages/Analysis/SavedDecision.tsx`. The old addresses carry `job` (repeated), `report`, `org`, `project`, `study`, `run`
and `cell` in their query.

## 2. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Where the redirects live | one table `frontend/src/routes/retiredRoutes.tsx`, extended by every slice; it is not part of `routeDefinitions`, so the registry counts only screens | a `retired` flag on route definitions: the registry test, the gallery and the screen count would all have to filter it out; one redirect per page file: scattered, and the link scan could not exempt one file |
| Table shape | `export const RETIRED_ROUTES: readonly RetiredRoute[]` with `RetiredRoute = { id: string; path: string; slice: 1 \| 2 \| 3 \| 4 \| 5; target: (query: URLSearchParams) => string }`; `id` keeps the old screen id for the record, `target` is a pure function returning an absolute address that starts with `/` | a map of path to fixed address: slice 1 needs the query to choose the target |
| How a redirect runs | `AppRoutes` mounts one `<Route path={retired.path}>` per entry inside the protected application layout, whose element is a `<Navigate to={retired.target(searchParams)} replace />`; no page code is loaded | a redirect before the guard: a signed-out visitor would land on a target that redirects to `/login` anyway; the guard already remembers path and query (`req~frontend-workspace-client-guard~1`), so after sign-in the old address is opened again and redirected |
| Precedence over dynamic paths | the retired paths are static segments, which React Router ranks above `/app/:org` and `/app/:org/:project`; without the table, `/app/analysis` would open the organization page of an organization named `analysis` | a guard in the organization page: couples it to retirements |
| Reading the query | `query.get(key)` (the first value of a key); a missing or empty value counts as absent; each value is put into the target with `encodeURIComponent`, one path segment each; the target carries no query and no hash | keeping unknown parameters: the target screens do not read them, and `job`/`report`/`cell` have no meaning there |
| Slice 1 rule | both paths share one `target`: run page when `org`, `project`, `study` and `run` are present; study page when `org`, `project` and `study` are; `/app/jobs` otherwise. `cell` is dropped (the run page is the closest screen that exists for every run) | the cell page for `cell`: a cell id without its run checks is often stale in old links; the job detail for a single `job`: one link would choose a job among several, and the job history lists them all |
| Links of slice 1 | removed, not re-pointed (§3): each one was the way into the decision space and none has an equivalent destination yet | re-pointing Weigh trade-offs to the run page: it would promise a trade-off set that is a later milestone |
| Report page | `SavedDecision` moves to `pages/Reports/SavedDecision.tsx` and renders an unrecognised reference as the text `unrecognised reference` instead of `JSON.stringify(ref)` (§4) | deleting the saved-decision view: the report page stays until slice 2 and would lose the decision it shows; keeping the file under `pages/Analysis/`: the folder goes |
| Link check | `routes/links.test.ts` gains a scan of every string and template literal of the non-test sources (§6), beside its existing scan of `to`/`href`/`navigate` addresses, which misses addresses kept in variables (`JobList.tsx` `analyseHref`, `RepDetail.tsx` `reopen`) | extending the `LINK` pattern only: it reads only the attribute forms |
| Allow-list ceiling | `MAX_ALLOWED_OFFENDERS` equals the number of entries, checked by an exported pure function `ceilingMismatch(max, entries)` tested with synthetic values and run on the real list | `<=` as today: a ceiling left high lets an entry come back unnoticed |

## 3. Links of slice 1

| Where | Link today | After slice 1 |
|---|---|---|
| `pages/Jobs/JobDetail.tsx` | Analyze, `/app/analysis/workspace?job=<id>` for a completed job | removed |
| `pages/Jobs/JobList.tsx` | Analyze N selected, `/app/analysis/workspace?job=<a>&job=<b>` | removed, with the selection it alone used if nothing else reads it |
| `pages/Jobs/JobHistory.tsx` | Analyze per completed row | removed |
| `components/BindingAnalysis/BindingAnalysis.tsx` | Open analysis, `/app/analysis/workspace?job=<id>` | removed; the card stays |
| `pages/Studies/StudyAnalytics.tsx` | Weigh trade-offs, `/app/analysis` | removed |
| `pages/Reports/RepDetail.tsx` | Reopen decision space, `/app/analysis/workspace?report=<org>/<project>/<report>` | removed; the decision view stays (§4) |
| `components/PlatformShell/appNavigation.ts` | main entry Analysis and the section `analysis` of `currentSection` | removed; `MainSection` loses `analysis` |
| `components/PlatformShell/paletteCommands.ts` | Go to › Analysis | removed |

## 4. Report page

`RepDetail.tsx` keeps its decision view until the report editor retires (slice 2). Its component moves from
`pages/Analysis/SavedDecision.tsx` to `pages/Reports/SavedDecision.tsx` with the CSS it uses. The fallback of the
binding `<dd>` changes from `JSON.stringify(ref)` to the text `unrecognised reference`; the report's existing source
view still shows the whole document. The moved file is no detector finding, so unlisted finding 17 leaves the
allow-list instead of moving with it.

## 5. Allow-list

- Slice 1 removes the entry of offender 7 (`pages/Analysis/Inspector.tsx`, deleted with the folder) from
  `RAW_RENDERING_ALLOW_LIST` and the entry 17 (`pages/Analysis/SavedDecision.tsx`) from `UNLISTED_FINDINGS`.
  Unlisted finding 16 (`pages/Workbench/SourcePanel.tsx`) stays.
- `MAX_ALLOWED_OFFENDERS` becomes 14. The shape test of `rawRenderingHygiene.test.ts` changes from "exactly 1–15" to "a
  strictly increasing subset of 1–15", and from "at most `MAX_ALLOWED_OFFENDERS` entries" to "exactly
  `MAX_ALLOWED_OFFENDERS` entries" (`ceilingMismatch`). The `retiredBy` values of the remaining entries are unchanged.
- Offenders 5 (`pages/Reports/RepDetail.tsx`) and 11 leave with slices 2 and 3; each of those slices lowers the ceiling
  by the entries it removes.
- The requirement `req~frontend-rendering-raw-hygiene~1` of the unarchived change `m21-rendering-catalogue` states
  `MAX_ALLOWED_OFFENDERS` 15 and offenders exactly 1–15 in its scenario "Today's offenders are listed". That change is
  not edited here (its owner archives it); the requirements of this change state the new values, and the conflict is a
  follow-up for the archive of m21 (tasks.md).

## 6. Link scan

- Sources: the `.ts` and `.tsx` files under `frontend/src` without `*.test.*` and `src/test/**`, read as text, as in
  `links.test.ts` today. The only exempt file is `routes/retiredRoutes.tsx`.
- A finding is a single-quoted, double-quoted or template literal whose text starts with a retired path of
  `RETIRED_ROUTES`, written with its parameters replaced as in the table, and continues with the end of the literal,
  `/`, `?`, `#` or `${`. So `'/app/analysis'`, `` `/app/analysis/workspace?job=${id}` `` and `'/app/analysis#x'` are
  findings; `'/app/analysisx'`, `'/v1/analysis/sources'` and `'/app/:org/:project/studies'` are not.
- The check is a pure exported function `retiredAddresses(sources, retiredPaths)` returning `<file>: <literal>` per
  finding, tested with synthetic sources, then run on the application sources, where it returns an empty list.
- Known limits: an address built from pieces (`'/app/' + 'analysis'`) is not seen; an apostrophe or `//` in JSX text
  can hide a later literal on the same line (pinned by a `known limit` test).

## 7. Requirements and the slice that delivers each

| Requirement | Slice |
|---|---|
| `frontend-retire-screens-not-routed` | shared; slice 1 values |
| `frontend-retire-redirect-generic` | shared; slice 1 values |
| `frontend-retire-redirect-decision-space` | 1 |
| `frontend-retire-no-link-to-retired` | shared; slice 1 values |
| `frontend-retire-navigation` | shared; slice 1 values |
| `frontend-retire-palette` | shared; slice 1 values |
| `frontend-retire-allow-list-leaves` | shared; slice 1 values |
| `frontend-retire-allow-list-ceiling` | shared; slice 1 values |
| `frontend-retire-screen-count` | shared; slice 1 values |
| `frontend-retire-gateway-untouched` | shared; slice 1 values |

Tests carry `[utest->req~frontend-retire-<name>~1]`; `retiredRoutes.tsx`, `index.tsx`, `appNavigation.ts` and
`paletteCommands.ts` carry `[impl->…]` for the requirements they implement. The gateway requirement is a constraint on
the diff: it is checked by the reviewer against the PR's changed paths, the gateway's existing tests of `/v1/analysis/*`
stay as they are, and it has neither an `[impl->…]` nor a `[utest->…]` tag.

## 8. Risks

- Old links whose query the table does not read (`job`, `report`, `cell`) land on the job history, not on the view
  they showed. Accepted: the view no longer exists; the job history lists every job.
- An organization with the slug `analysis` cannot be opened at `/app/analysis`, as today; slug reservation is not part
  of this change.
- Slice 1 deletes the whole `pages/Analysis/` folder and its tests, far more than ~300 lines; the lines it adds or
  changes stay near the guideline (constitution 14.1). The deletions are mechanical and reviewed as such.
- The Playwright specs `s7b-reports.spec.ts`, `qa-gallery.spec.ts`, `helpers/galleryRoutes.ts`,
  `visual-shell.spec.ts`, `s6a-jobs.spec.ts` and `s7a-studies.spec.ts` open or expect the retired addresses; they are
  updated in slice 1, and the gallery drops two screens. `analysis-live.spec.ts` is deleted.
- The frontend API client for `/v1/analysis/*` and `frontend/src/analysis/` stay while other code uses them; unused
  parts are removed with the endpoints (M9.6), not here.

## 9. Rollback

Reverting the slice-1 PR restores both screens, their links and the two allow-list entries; nothing outside
`frontend/` changes, and no data or API is touched.
