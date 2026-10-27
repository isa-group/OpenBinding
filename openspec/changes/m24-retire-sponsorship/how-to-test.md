# How to test: m24-retire-sponsorship (slice 5, sponsorship)

Change: `openspec/changes/m24-retire-sponsorship`. The administrators' sponsorship screen is retired. Its address
redirects to the administration overview, the two controls that opened it are gone, and the registry holds 69 screens
(D8 = 8).

Not verified: the develop preview does not contain this change, and no browser or Playwright run was available when
this guide was written. The steps are what to expect once the change is on a preview; CI is the evidence for the
automated checks. No API examples: the change touches no gateway endpoint.

Demo data: organization `isa-demo`. Sign in on `/login`, first with an account that has the platform administrator
role, then with an account that does not.

## UI steps

**1. The old address redirects** (signed in as an administrator; the address bar must show the target)

| Open | Expect the address to become |
|---|---|
| `/app/admin/organizations/isa-demo/sponsor` | `/app/admin` |
| `/app/admin/organizations/isa-demo/sponsor?tab=requests#limits` | `/app/admin` (query and hash dropped) |
| `/app/admin/organizations/<id of isa-demo>/sponsor` | `/app/admin` |
| `/app/admin/organizations/cases/sponsor` | `/app/admin` (outranks the case screens, design.md §2) |
| `/app/admin/users/<an account id>` | stays: the account detail |

The overview shows the heading `Administration`. Signed out first: open the sponsorship address, expect `/login`,
then `/app/admin` after signing in as an administrator. Back returns to the previous page, not to the old address.

**2. A person without the administrator role**
- Open `/app/admin/organizations/isa-demo/sponsor`: the address becomes `/app/account`, as it did before the change;
  no administration screen and no `Admin` link are shown.

**3. No way left to the screen** (as an administrator)
- Administration overview `/app/admin`: the Tools section lists `Accounts`, `Account agreement`, `Audit log`, `Errors`,
  `Queues`, `Moderation` and `Maintenance`; there is no `Sponsorship transfer` tool and no `Organization slug or id`
  field. The lede reads "How the platform is doing, and where to act. Contract, pricing and maintenance changes are
  recorded in the audit log."
- Account detail `/app/admin/users/<id>`: no `Organizations` card and no `Open sponsorship` button; the key form
  (`Key id`, `Revoke key`) is still there.
- Kept on purpose: the organization settings of `isa-demo` (`/app/isa-demo/settings`) still offer the owner the
  change-sponsor section, and the audit log still lists sponsor requests (design.md §3).

**4. Route count**
- The QA gallery and the route smoke list 69 screens; `admin-sponsor` is not among them. D8 lists `admin-overview`,
  `admin-users`, `admin-user-detail`, `admin-audit`, `admin-errors`, `admin-queues`, `admin-moderation`,
  `admin-maintenance`.

**5. Automated checks (repository root, at the PR head)**
- `pnpm --dir frontend exec vitest run src/routes src/test src/pages/Admin`. Expect all pass: 69 screens (D8 = 8),
  `admin-sponsor` absent, redirect and link-scan tests, the removed controls, allow-list ceiling 12.
- `pnpm --dir frontend exec playwright test e2e/s9a-admin.spec.ts e2e/routes-smoke.spec.ts e2e/qa-gallery.spec.ts`.
  Expect the gallery to list 69 screens and the sponsorship smoke (`e2e/s9a-admin.spec.ts`) to land on `/app/admin`.
