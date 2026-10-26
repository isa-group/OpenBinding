# Design: m24-retire-screens-3

Status: slice 3 of M2.4 (library catalogue and project resources). The shared rules are in `m24-retire-screens`
(slice 1) and `m24-retire-screens-2` (slice 2, path params, link scan tail form, retired routes mounted after the
screens), both merged and not archived. Fixed inputs: ROADMAP M2.4, ADR-0020 decisions 2 and 5, INTENT D8, the
registry after slice 2 (78 screens, D4 18), the allow-list after slice 2 (13 offenders, unlisted finding 16).

## 1. Context

Seven screens of domain D4 (`frontend/src/routes/d4.tsx`) go:

| Id | Path | Page |
|---|---|---|
| `lib-list` | `/app/:org/library` | `pages/Library/LibList.tsx` |
| `lib-artifact` | `/app/:org/library/:artifact` | `pages/Library/LibArtifact.tsx` |
| `lib-draft` | `/app/:org/library/:artifact/drafts/:draft` | `pages/Library/LibDraft.tsx` |
| `lib-version` | `/app/:org/library/:artifact/versions/:version` | `pages/Library/LibVersion.tsx` |
| `proj-library` | `/app/:org/:project/library` | `pages/Library/ProjLibrary.tsx` |
| `proj-resources` | `/app/:org/:project/resources` | `pages/Resources/ProjResources.tsx` |
| `proj-resource-detail` | `/app/:org/:project/resources/:resource` | `pages/Resources/ProjResourceDetail.tsx` |

The files of `pages/Library/` and `pages/Resources/` that nothing imports after the deletion go with their tests,
including `ContentView.tsx` (offender 11); `utils/bimVocabulary.ts` loses `migrateContent`. `pages/Library/fixtures.ts`
stays while `e2e/helpers/mockApi.ts` imports it (tasks.md follow-ups). `ProjFiles`, `CollList` and `CollDetail` stay.

## 2. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Library target | `/app/<org>` (organization overview) for the four library paths; artifact, draft, version, query and hash dropped | the project collections: an organization library has no project; a list of artifacts elsewhere: there is none left |
| Project target | `/app/<org>/<project>/collections` for `proj-library`, `proj-resources`, `proj-resource-detail` | the project overview: collections are where ADR-0020 keeps grouped problems |
| Table order | library entries first, then slices 1 and 2, then the project entries; all mounted after the screens | project entries first: `/app/<org>/library/resources` would open the collections of a project `library` |
| Ties | React Router breaks equal scores by sibling order. Screen vs retired: the screen wins (`/app/<org>/library/collections` stays `coll-list`, likewise `cases`, `files`). Retired vs retired: the earlier entry wins, so `/app/<org>/library/reports`, `/library/library` and `/library/resources` open `/app/<org>` (supersedes slice 2's `lib-artifact` exception, which no longer exists) | a reserved project slug `library`: a data rule for a routing problem |
| Navigation | tab `Library` → `Collections` (key `collections`, suffix `/collections`), palette `Collections` (`Problems grouped into suites`); `ProjectLibraryNav` removed; organization-level navigation drops `library`; `RESERVED_SLUGS` keeps `library` and `resources` | dropping the tab: collections would lose their way in |
| Resolver (frontend) | `resolveModel` points a resource revision at `<base>/collections` | the organization overview: the location names a project |
| Gateway resolver | unchanged; `library_version_url` still emits `/app/<org>/library/<artifact>/versions/<v>`, which now redirects; listed in `KNOWN_REDIRECTING_WEB_URLS` of `openbinding-gateway/tests/test_b2_resolve_urls.py`; retargeted in M9.6 or earlier | changing `routes/resolve.py` now: a gateway change outside this frontend slice |
| API client | `api/library*.ts`, gateway, engines, `docs/openapi.json` untouched; no `Deprecation`/`Sunset` (owner CRP, M9.6) | removing the client now: decision 5 retires code after the endpoints |

## 3. Links of slice 3

| Where | Today | After |
|---|---|---|
| `ProjectTabs.tsx`, `paletteCommands.ts` | `Library`, `<root>/library` | `Collections`, `<root>/collections` |
| `appNavigation.ts`, organization navigation | `library` entry | removed |
| `pages/Cases/CaseComposer.tsx` | `Open in library`, `Find in library`, issue action `library` | removed |
| `pages/Cases/CaseList.tsx` | `Open the library` | removed |
| `pages/Cases/CaseRevision.tsx` | resource cards link to `lib-version`, note `… · open in library` | no link; note `Published`, `Not published` or `Withdrawn` |
| `pages/Jobs/` launch and detail | `Edit the candidate`, `edit the candidates`, `Open the library` | removed; `Engines` stays |
| `pages/Organization/OrgOverview.tsx` | action `Library` | removed |
| `pages/AppHome/AppHome.tsx` | "a shared library" | worded without the library |
| `pages/Resources/CollDetail.tsx` | resource pins link to the library; `section="library"` | pins without link; `section="collections"` |
| `pages/Resolve/resolveModel.ts` | resource revision `<base>/library…` | `<base>/collections` |

## 4. Link scan

Unchanged rules of slice 2; the slice-3 entries add the tails `/library…` and `/resources…`. Files under `src/api/`
keep their gateway paths and are exempt from the tail form only.

## 5. Allow-list

Offender 11 leaves `RAW_RENDERING_ALLOW_LIST`; `MAX_ALLOWED_OFFENDERS` 12; numbers 1–4, 6, 8–10, 12–15; unlisted
finding 16 stays.

## 6. Requirements, tests and earlier scenarios

| Requirement | Tests |
|---|---|
| `frontend-retire-library-redirect` | `routes/retiredRoutes.test.tsx` |
| `frontend-retire-library-screens-not-routed`, `-screen-count` | `routes/routes.test.ts` |
| `frontend-retire-library-no-link` | `routes/links.test.ts`, `pages/Resolve/Resolve.test.tsx` |
| `frontend-retire-library-navigation` | `SectionNav.test.tsx`, `paletteCommands.test.ts`, `appNavigation.test.ts` |
| `frontend-retire-library-allow-list` | `test/rawRenderingHygiene.test.ts` |
| `frontend-retire-library-entry-points-removed` | page tests of §3 |

Tests carry `[utest->req~frontend-retire-library-<name>~1]`; `retiredRoutes.tsx`, `d4.tsx`, `ProjectTabs.tsx`,
`paletteCommands.ts` and `rawRenderingAllowList.ts` carry `[impl->…]`.

Values of earlier changes that slice 3 changes, reconciled at the archive: slice 2's scenario "An artifact named
reports keeps its screen", its tab lists (`Library`), 78 screens and D4 18, offenders with 11 and ceiling 13; slice 1's
counts and ceilings; `req~frontend-retire-gateway-untouched~1`, since one gateway test file changes. Slice-1/2 tests
that iterate over `RETIRED_ROUTES` stay limited to their own `slice`; `retiredScreens.test.tsx` moves to 71 and 12.

## 7. Risks

- An old library or resource link lands on the organization overview or the collections, not on the item. Accepted:
  the catalogue no longer exists; data stays in the gateway until M9.6.
- The gateway resolver emits a redirecting address until it is retargeted; the redirect keeps it useful.
- A project slugged `library` loses its overview (`/app/<org>/library` is static and outranks `/app/:org/:project`)
  and its `/library`, `/resources` and `/reports` sub-addresses (they redirect), but keeps its routed sections.
- The slice deletes far more than ~300 lines; added or changed lines stay near the guideline (constitution 14.1).

## 8. Rollback

Reverting the PR restores the seven screens, their links, the `Library` tab and command, offender 11 with ceiling 13,
and drops the `KNOWN_REDIRECTING_WEB_URLS` entry. No data or API is touched.
