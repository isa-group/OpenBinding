# Design: m24-retire-composer

Status: slice 4 of M2.4 (composer). The shared rules are in `m24-retire-screens` (slice 1), `m24-retire-screens-2`
(slice 2: path params, link scan tail form, retired routes mounted after the screens) and `m24-retire-screens-3`
(slice 3: entry order and ties among retired routes), all merged and not archived. Fixed inputs: ROADMAP M2.4, ADR-0020
decisions 2 and 5 and its consequences (workbench and composer merge), INTENT §6, the registry after slice 3 (71
screens, D4 11), the allow-list after slice 3 (12 offenders, unlisted finding 16).

## 1. Context

One screen of domain D4 (`frontend/src/routes/d4.tsx`) goes:

| Id | Path | Page |
|---|---|---|
| `case-composer` | `/app/:org/:project/cases/:case/compose` | `pages/Cases/CaseComposer.tsx` |

`CaseComposer.tsx` and `CaseComposer.test.tsx` are deleted, with the composer rules of `pages/Cases/Cases.css`
(`.case-composer`, `.case-compose-main`, `.case-compose-aside` and the selectors and media rule that name them) and every
helper only the composer imports. Today these are `pages/Cases/compositionModel.ts` (with its test), `SizeMeter` of
`pages/Cases/parts.tsx`, and `composeRefusal` and `resolveRefusal` of `pages/Cases/caseErrors.ts` (with their test
cases); the build checks this list again: what another non-test file still imports stays (`Power`, `useLoadedMap`,
`planLimit`, `classifyAuthError`, `isMissing`, `marker`).

The replacement exists: the workbench `wb-workbench` (`/app/:org/:project/workbench`) reads the query key `case`,
preselects that case in its `Case revision` source and saves a valid package as a revision of it. Slice 4 does not
change the workbench.

## 2. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Target | `/app/<org>/<project>/workbench?case=<case>`; `org`, `project` and `case` from the opened path, each re-encoded with `encodeURIComponent` (React Router hands them decoded); the opened query (`?from=…`) and hash dropped; an absent or empty `org`, `project` or `case`, which the router never produces for this path, gives `/app` | the case detail: one more click to the editor that replaces the composer; carrying `from` as `revision`: the workbench opens a revision read-only to edit, while `from` meant "start a new revision from this one", a different promise |
| Table entry | `{ id: 'case-composer', path: '/app/:org/:project/cases/:case/compose', slice: 4, target: workbenchTarget }` appended after the slice-3 project entries; mounted after the screens like the others, behind the signed-in guard, keeping `state.from` | a place before the slice-3 entries: changes nothing for screens, but would take the ties below from the library entries of slice 3 |
| Ties | No screen ties: the only routed six-segment path with the same shape, `case-compare` (`/cases/:case/compare`), differs in its static last segment, and the seven-segment `case-revision` cannot match. Among retired routes, `lib-draft` and `lib-version` (`/app/:org/library/:artifact/drafts/:draft`, `/versions/:version`) score the same as the composer path (three static, three dynamic segments) and both match `/app/<org>/library/cases/drafts/compose` and `/app/<org>/library/cases/versions/compose` (a project `library`, a case `drafts` or `versions`). The earlier entry wins, so these two addresses open `/app/<org>`, as slice 3 already does for a project slugged `library` | a reserved project slug `library`: a data rule for a routing problem |
| Controls | the controls of §3 keep their names and their visibility and lead to `<root>/workbench?case=<slug>` (`<slug>` percent-encoded) | removing them: the case screens would lose their only way to a new revision; renaming them: the names still describe what the person does |
| Texts | reworded so no screen names the composer (§3) | leaving them: they would promise a screen that no longer exists |
| Allow-list | unchanged: the composer is no offender of `RAW_RENDERING_ALLOW_LIST`; `MAX_ALLOWED_OFFENDERS` stays 12 and needs no requirement | — |
| API client | `api/library.ts` keeps the reads the composer used (other screens and the version picker still call them); `api/cases.ts`, gateway, engines and `docs/openapi.json` untouched; no `Deprecation`/`Sunset` (owner CRP, M9.6) | removing the reads now: decision 5 retires code after the endpoints |

## 3. Links of slice 4

`<root>` is `/app/<org>/<project>`.

| Where | Today | After |
|---|---|---|
| `pages/Cases/CaseList.tsx` row action (`canCreate`) | `New revision`, `<root>/cases/<slug>/compose` | `New revision`, `<root>/workbench?case=<slug>` |
| `pages/Cases/CaseList.tsx` notice after creating a case | `Compose its first revision`, `<root>/cases/<slug>/compose` | `Compose its first revision`, `<root>/workbench?case=<slug>` |
| `pages/Cases/CaseList.tsx` empty state | "Start from a ready example, or compose one: pick a workflow, a candidate catalog, constraints and a goal." | "Start from a ready example, or create a case and save its first revision from the workbench." |
| `pages/Cases/CaseDetail.tsx` header action (`canCreate`) | `New revision`, `<root>/cases/<slug>/compose` | `New revision`, `<root>/workbench?case=<slug>` |
| `pages/Cases/CaseDetail.tsx` guide of a case without revisions (`canCreate`) | `Compose the first revision`, `<root>/cases/<slug>/compose` | `Compose the first revision`, `<root>/workbench?case=<slug>` |
| `pages/Cases/CaseDetail.tsx` revision without snapshot | "Create a new revision from the composer to get one." | "Save a new revision from the workbench to get one." |
| `pages/Cases/CaseCompare.tsx` actions | `New revision`, `${base}/compose` | `New revision`, `<root>/workbench?case=<slug>` |
| `pages/Jobs/JobResult.tsx` infeasible result with an origin case | `Try faster providers`, `<root>/cases/<slug>/compose` | `Try faster providers`, `<root>/workbench?case=<slug>` |

A VIEWER sees none of the case controls today (`canCreate` false) and sees none after; the job result shows its link
under the same condition as today (a known origin case).

## 4. Link scan

Unchanged rules of slices 2 and 3; the slice-4 entry adds the full form `/app/:org/:project/cases/:case/compose` and the
tail form `${…}/cases/${…}/compose` (the tail is the part from `cases`, each `:case` standing for one segment or one
`${…}`). Known limit: `CaseCompare.tsx` writes `${base}/compose` with `base` already holding `/cases/<slug>`; the scan
cannot see it, so the case comparison's page test pins the new `href`.

## 5. Allow-list

Unchanged: offenders 1–4, 6, 8–10, 12–15, ceiling 12, unlisted finding 16. The slice-1 rule (`ceilingMismatch`) keeps
holding with no edit.

## 6. Requirements, tests and earlier scenarios

| Requirement | Tests |
|---|---|
| `frontend-retire-composer-redirect` | `routes/retiredRoutes.test.tsx` |
| `frontend-retire-composer-screen-not-routed`, `-screen-count` | `routes/routes.test.ts` |
| `frontend-retire-composer-no-link` | `routes/links.test.ts` |
| `frontend-retire-composer-entry-points-repointed` | `pages/Cases/CaseList.test.tsx`, `CaseDetail.test.tsx`, `CaseCompare.test.tsx`, `pages/Jobs/JobDetail.test.tsx` |

Tests carry `[utest->req~frontend-retire-composer-<name>~1]`; `retiredRoutes.tsx`, `d4.tsx`, `CaseList.tsx`,
`CaseDetail.tsx`, `CaseCompare.tsx` and `JobResult.tsx` carry `[impl->…]`. `JobResult.tsx` has no test of its own; the
job detail test renders it.

Values of earlier changes that slice 4 changes, reconciled at the archive: slice 3's D4 list with `case-composer`, 71
screens and D4 11, the Evidence `CaseComposer.test.tsx` of `req~frontend-retire-library-entry-points-removed~1` and its
scenario "Composer and case list"; slice 1's counts and the statement of `req~frontend-retire-redirect-generic~1` and
its decision "the target carries no query" (the composer target carries `case`). Slice-1/2/3 tests that iterate over
`RETIRED_ROUTES` stay limited to their own `slice`; `retiredScreens.test.tsx` moves to 70 and 12.

## 7. Risks

- An old composer link opens the workbench, not the four-part composition form, and loses `from`. Accepted: the
  workbench is the one editor (ADR-0020, INTENT §6); the case is preselected and its revisions are one click away.
- A person who composed from library versions now edits a whole package; the full problem editor is M3.6.
- A project slugged `library` with a case `drafts` or `versions` loses its composer redirect to the organization
  overview (§2 ties); the case itself stays reachable.
- The slice deletes far more than ~300 lines; added or changed lines stay at about 300 or fewer (constitution 14.1).

## 8. Rollback

Reverting the PR restores the screen, its page, test, styles and helpers, the composer links and texts, 71 screens and
D4 11. No data or API is touched.
