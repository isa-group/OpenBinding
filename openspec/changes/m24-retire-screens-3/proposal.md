# Change: m24-retire-screens-3

## Why

ROADMAP M2.4: "Retirements, screens first (ADR-0020): decision-space workspace, report editor, library catalogue and
project resources, composer, sponsorship; old URLs redirect to their replacement", accepted when "offenders 5, 7 and 11
gone with their screens; the route count drops; no link leads to a retired screen". ADR-0020 decision 2 retires "the
library as a catalogue" (owner, 2026-10-22, INTENT D8); decision 5: "Screens go first, then endpoints".

Slices 1 and 2 are the changes `m24-retire-screens` and `m24-retire-screens-2`, merged and not archived. Their
requirements cannot be modified before the archive, so slice 3 adds new ids `req~frontend-retire-library-<name>~1` on
the same capability and the same redirect table.

## What Changes

Slice 3 retires the library catalogue and the project resources:
- `lib-list`, `lib-artifact`, `lib-draft`, `lib-version` (`/app/:org/library…`) and `proj-library`, `proj-resources`,
  `proj-resource-detail` (`/app/:org/:project/library`, `/resources`, `/resources/:resource`) are no longer screens;
  the registry drops from 78 to 71 screens, domain D4 from 18 to 11.
- The four library addresses open the organization overview `/app/<org>`; the three project addresses open the
  project's collections `/app/<org>/<project>/collections`.
- The project tab and palette command `Library` become `Collections`; the `ProjectLibraryNav` pill navigation and the
  organization-level `library` entry go.
- The ways into the library go (composer, case list, case revision, job launch and detail, organization overview,
  collection pins); the public resolver points a resource revision at `<base>/collections`.
- The allow-list loses offender 11 (`pages/Library/ContentView.tsx`); `MAX_ALLOWED_OFFENDERS` drops from 13 to 12.

## Impact

- Capability `frontend-workspace`: seven ADDED requirements, all `~1`: `frontend-retire-library-redirect`,
  `-screens-not-routed`, `-no-link`, `-navigation`, `-allow-list`, `-screen-count`, `-entry-points-removed`.
  Slice-1/2 scenarios with values slice 3 changes are reconciled at the archive (design.md §6).
- Code: `frontend/src/routes/` (`d4.tsx`, `retiredRoutes.tsx`, tests), `frontend/src/pages/Library/` and the retired
  pages of `pages/Resources/` deleted with their tests, the pages of design.md §3, `components/PlatformShell/`,
  `utils/bimVocabulary.ts` (`migrateContent`), `frontend/src/test/` (allow-list); the Playwright specs (tasks.md S3).
- `openbinding-gateway/tests/test_b2_resolve_urls.py` lists `/app/:org/library/:artifact/versions/:version` in
  `KNOWN_REDIRECTING_WEB_URLS`: the gateway resolver still emits it for resource and collection versions. It is the
  only file under `openbinding-gateway/` that changes; no gateway source, engine, worker, `docs/openapi.json` or
  frontend API client (`api/library*.ts`) changes, and no endpoint gets `Deprecation` or `Sunset` (owner CRP, M9.6).
  The shared `req~frontend-retire-gateway-untouched~1` therefore does not hold as written for this diff; it is
  reconciled at the archive.
- `ROADMAP.md` slice status (never its `Status: PROPOSED` lines).
- Risks (design.md §7): old library permalinks land on the organization overview, not on the artifact.
- G1: no `openspec` binary in the lab; CI runs `openspec validate --strict --all`. The layout copies slice 2.

## Out of scope

- Gateway endpoints and the resolver's library URLs (retargeted in M9.6 or earlier), `Deprecation`/`Sunset` headers.
- The "Publish" of a collection version (ADR-0020 decision 2): a later milestone.
- Slices 4 and 5 (composer, sponsorship); editing `openspec/specs/**`, earlier changes, ADR-0020 or INTENT; archiving.
