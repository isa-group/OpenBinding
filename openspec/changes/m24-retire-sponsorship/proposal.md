# Change: m24-retire-sponsorship

## Why

ROADMAP M2.4: "Retirements, screens first (ADR-0020): decision-space workspace, report editor, library catalogue and
project resources, composer, sponsorship; old URLs redirect to their replacement", accepted when "offenders 5, 7 and 11
gone with their screens; the route count drops; no link leads to a retired screen". ADR-0020 retires "organization
sponsorship, made redundant by per-account SPACE contracts (ADR-0015)" (context, decision 2) and keeps instead
"administrators assign RESEARCH or LAB in SPACE" (decision 3); decision 5: "Screens go first, then endpoints". INTENT
D3: "retire sponsorship; plans are per-account SPACE contracts, RESEARCH and LAB assigned by agreement"; D8 decided.

Slices 1 to 4 are the changes `m24-retire-screens`, `m24-retire-screens-2`, `m24-retire-screens-3` and
`m24-retire-composer`, merged and not archived. Their requirements cannot be modified before the archive, so slice 5
adds new ids `req~frontend-retire-sponsorship-<name>~1` on the same capability and the same redirect table.

## What Changes

Slice 5 retires the administrators' sponsorship screen:
- `admin-sponsor` (`/app/admin/organizations/:org/sponsor`, `pages/Admin/AdminSponsor.tsx`) is no longer a screen; the
  registry drops from 70 to 69 screens, domain D8 from 9 to 8.
- The sponsorship address opens the administration overview `/app/admin`; the organization, the query and the hash are
  dropped. The overview is the administrators' entry point, and plans are now per-account SPACE contracts that an
  administrator assigns by agreement (INTENT D3, ADR-0020).
- The two controls that opened the screen are removed, not repointed, because the screen was the only function
  behind them: the `Sponsorship transfer` tool of the administration overview, and the `Organizations` card
  (`Open sponsorship`) of the administration account detail. The overview's lede no longer names sponsorship.
- No allow-list change: the sponsorship screen is not an offender; `MAX_ALLOWED_OFFENDERS` stays 12.

## Impact

- Capability `frontend-workspace`: five ADDED requirements, all `~1`: `frontend-retire-sponsorship-redirect`,
  `-screen-not-routed`, `-no-link`, `-entry-points-removed`, `-screen-count`. Scenarios of slices 1 to 4 with values
  slice 5 changes are reconciled at the archive (design.md §6).
- Code: `frontend/src/routes/` (`d8.tsx`, `retiredRoutes.tsx`, tests), `pages/Admin/AdminSponsor.tsx` deleted with its
  test and the rules of `AdminScreens.css` only it and the removed controls used (design.md §1),
  `pages/Admin/AdminOverview.tsx` and `AdminUserDetail.tsx` (design.md §3); the Playwright specs (tasks.md S5).
- No gateway source or test, engine, worker, `docs/openapi.json` or frontend API client (`api/*.ts`) changes:
  `apiClient.adminTransferSponsor` and the other sponsor calls of `api/client.ts` and `api/auth.ts` stay, and no
  endpoint gets `Deprecation` or `Sunset` (owner CRP, M9.6). `req~frontend-retire-gateway-untouched~1` holds as written
  for this diff.
- `ROADMAP.md` slice status (never its `Status: PROPOSED` lines).
- Risks (design.md §7): administrators lose the screen to move a sponsorship; the endpoint stays for API use.
- G1: no `openspec` binary in the lab; CI runs `openspec validate --strict --all`. The layout copies slice 4.

## Out of scope

- The organization-level sponsor surfaces, which are other screens and stay: the change-sponsor section of
  `pages/Organization/OrgSettings.tsx` (`org-settings`), `pages/Organization/SponsorCards.tsx`,
  `pages/Organization/sponsorModel.ts`, the sponsor step of `OrgCreate.tsx` (`org-create`),
  `pages/Account/SponsorRequestsForYou.tsx` (`acct-notifications`), the sponsor requests of the notification dropdown,
  and `pages/Resources/useSponsorUsage.ts`, still imported by `CollList.tsx` and `ProjFiles.tsx`. Whether the
  organization-level sponsor flow retires too is a later owner decision (tasks.md, follow-ups).
- Gateway endpoints (`POST /v1/admin/organizations/{id}/sponsor`, `/v1/sponsor-proposals`), `Deprecation`/`Sunset`
  headers (owner CRP, M9.6), the API client, the sponsorship capacity checks (M4.3) and the sponsorship data (M9.6).
- The texts that describe sponsor events or sponsored limits without promising the retired screen (design.md §3).
- Editing `openspec/specs/**`, earlier changes, ADR-0020 or INTENT; archiving.
