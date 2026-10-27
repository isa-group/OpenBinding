# Change: m24-retire-composer

## Why

ROADMAP M2.4: "Retirements, screens first (ADR-0020): decision-space workspace, report editor, library catalogue and
project resources, composer, sponsorship; old URLs redirect to their replacement", accepted when "offenders 5, 7 and 11
gone with their screens; the route count drops; no link leads to a retired screen". ADR-0020 names "the composer, a
second editor beside the workbench" among the screens to retire (decision 2) and lists "workbench and composer" among
the merges of INTENT §6 (consequences); decision 5: "Screens go first, then endpoints". The full problem editor is M3.6.

Slices 1 to 3 are the changes `m24-retire-screens`, `m24-retire-screens-2` and `m24-retire-screens-3`, merged and not
archived. Their requirements cannot be modified before the archive, so slice 4 adds new ids
`req~frontend-retire-composer-<name>~1` on the same capability and the same redirect table.

## What Changes

Slice 4 retires the case composer:
- `case-composer` (`/app/:org/:project/cases/:case/compose`, `pages/Cases/CaseComposer.tsx`) is no longer a screen; the
  registry drops from 71 to 70 screens, domain D4 from 11 to 10.
- The composer address opens the workbench with the case picked: `/app/<org>/<project>/workbench?case=<case>`. The
  workbench already saves a valid package as a revision of that case.
- The controls that opened the composer keep their names and open the workbench instead: `New revision` (case list,
  case detail, case comparison), `Compose its first revision` (case list notice), `Compose the first revision` (case
  detail), `Try faster providers` (job result). Whoever sees them today still sees them, with one change of
  audience: the comparison guide's `New revision`, shown to every reader before, is now shown only to people who can
  create revisions (`canCreate`), because the case list and detail already gate it and a viewer cannot save a revision.
- The texts that name the composer are reworded (case detail, case list empty state).
- No allow-list change: the composer is not an offender; `MAX_ALLOWED_OFFENDERS` stays 12.

## Impact

- Capability `frontend-workspace`: five ADDED requirements, all `~1`: `frontend-retire-composer-redirect`,
  `-screen-not-routed`, `-no-link`, `-entry-points-repointed`, `-screen-count`. Slice-1/2/3 scenarios with values slice
  4 changes are reconciled at the archive (design.md §6).
- Code: `frontend/src/routes/` (`d4.tsx`, `retiredRoutes.tsx`, tests), `pages/Cases/CaseComposer.tsx` deleted with its
  test, its rules of `Cases.css` and the helpers only it used (design.md §1), the pages of design.md §3; the Playwright
  specs (tasks.md S4).
- No gateway source or test, engine, worker, `docs/openapi.json` or frontend API client (`api/*.ts`) changes; the API
  client keeps the library reads the composer used, and no endpoint gets `Deprecation` or `Sunset` (owner CRP, M9.6).
  `req~frontend-retire-gateway-untouched~1` holds as written for this diff.
- `ROADMAP.md` slice status (never its `Status: PROPOSED` lines).
- Risks (design.md §7): an old composer link opens the workbench, not the four-part composition form.
- G1: no `openspec` binary in the lab; CI runs `openspec validate --strict --all`. The layout copies slice 3.

## Out of scope

- The full problem editor (M3.6); any change to the workbench beyond being the target.
- Gateway endpoints, `Deprecation`/`Sunset` headers (owner CRP, M9.6), the library reads of `api/library.ts`.
- Slice 5 (sponsorship, `admin-sponsor`): a separate change; editing `openspec/specs/**`, earlier changes, ADR-0020 or
  INTENT; archiving.
