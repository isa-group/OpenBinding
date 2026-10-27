# How to test: m24-retire-composer (slice 4, composer)

Change: `openspec/changes/m24-retire-composer`. The case composer is retired. Its address redirects to the workbench
with the case picked, every control that opened it now opens the workbench under the same name, and the registry holds
70 screens (D4 = 10).

Not verified: the develop preview does not contain this change, and no browser or Playwright run was available when
this guide was written. The steps are what to expect once the change is on a preview; CI is the evidence for the
automated checks. No API examples: the change touches no gateway endpoint.

Demo account: organization `isa-demo`, project `qos-benchmarks`, case `checkout-flow` (use any case of the project).
Sign in by name on `/login`, first as a member, then as a viewer.

## UI steps

**1. The old address redirects** (signed in; the address bar must show the target)

| Open | Expect the address to become |
|---|---|
| `/app/isa-demo/qos-benchmarks/cases/checkout-flow/compose` | `/app/isa-demo/qos-benchmarks/workbench?case=checkout-flow` |
| `/app/isa-demo/qos-benchmarks/cases/checkout-flow/compose?from=2#check` | `/app/isa-demo/qos-benchmarks/workbench?case=checkout-flow` (other query and hash dropped) |
| `/app/isa-demo/qos-benchmarks/cases/checkout-flow/compare` | stays: the case comparison |
| `/app/isa-demo/library/cases/drafts/compose` | `/app/isa-demo` (tie with the slice-3 library entries, design.md §2) |

On the workbench, the `Case revision` source shows the case `checkout-flow` picked. Signed out first: open the composer
address, expect `/login`, then the workbench after signing in. Back returns to the previous page, not to the old
address.

**2. Controls that now open the workbench** (as a member; each `href` is `/app/isa-demo/qos-benchmarks/workbench?case=<slug>`)
- Case list: `New revision` on each row. Create a case: the notice link `Compose its first revision` opens the
  workbench with the new case picked.
- Case list of a project without cases: the empty state reads "Start from a ready example, or create a case and save its
  first revision from the workbench." (no composer).
- Case detail: `New revision`; on a case without revisions, `Compose the first revision`. On a revision without a
  snapshot the note ends "Save a new revision from the workbench to get one."
- Case comparison: `New revision`.
- Job detail of an infeasible run started from a case: `Try faster providers` opens the workbench; `See the rules`
  still opens the case revision.
- As a viewer: none of the case controls above is shown.

**3. Route count**
- The QA gallery and the route smoke list 70 screens; `case-composer` is not among them. D4 lists `case-list`,
  `case-detail`, `case-revision`, `case-compare`, `wb-workbench`, `snap-detail`, `proj-files`, `coll-list`,
  `coll-detail`, `gen-lab`.

**4. Automated checks (repository root, at the PR head)**
- `pnpm --dir frontend exec vitest run src/routes src/test src/pages/Cases src/pages/Jobs`. Expect all pass: 70
  screens (D4 = 10), `case-composer` absent, redirect and link-scan tests, the repointed controls, allow-list ceiling 12.
- `pnpm --dir frontend exec playwright test e2e/s5a-cases.spec.ts e2e/routes-smoke.spec.ts e2e/qa-gallery.spec.ts`.
  Expect the gallery to list 70 screens and the composer smoke to land on the workbench.
