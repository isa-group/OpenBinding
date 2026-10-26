# How to test: m24-retire-screens-3 (slice 3, library and project resources)

Change: `openspec/changes/m24-retire-screens-3`. The seven screens of the library catalogue and the project resources
are retired. Old addresses redirect, the project tab `Library` is now `Collections`, every entry point is gone, and the
registry holds 71 screens (D4 = 11).

Not verified: the develop preview does not contain this change, and no browser or Playwright run was available when
this guide was written. The steps are what to expect once the change is on a preview; CI is the evidence for the
automated checks. No API examples: the change touches no gateway endpoint.

Demo account: organization `isa-demo`, project `qos-benchmarks`. Sign in by name on `/login`.

## UI steps

**1. Old addresses redirect** (signed in; the address bar must show the target)

| Open | Expect the address to become |
|---|---|
| `/app/isa-demo/library` | `/app/isa-demo` |
| `/app/isa-demo/library/checkout-engines` | `/app/isa-demo` |
| `/app/isa-demo/library/checkout-engines/versions/2?tab=content#files` | `/app/isa-demo` (query and hash dropped) |
| `/app/isa-demo/qos-benchmarks/library` | `/app/isa-demo/qos-benchmarks/collections` |
| `/app/isa-demo/qos-benchmarks/resources` | `/app/isa-demo/qos-benchmarks/collections` |
| `/app/isa-demo/qos-benchmarks/resources/latency-table?revision=3` | `/app/isa-demo/qos-benchmarks/collections` |
| `/app/isa-demo/library/collections` | stays: the collections list of a project named `library` |

Signed out first: open one of them, expect `/login`, then the target after signing in. Back returns to the previous
page, not to the old address.

**2. Collections tab and palette command**
- Open `/app/isa-demo/qos-benchmarks`. Expect the tabs `Overview`, `Cases`, `Collections`, `Jobs`, `Studies`,
  `Publications`, `Files`, `Package`, `Settings`; no `Library`.
- Press `Ctrl+K`, type `Collections`. Expect the command `Project › Collections` (`Problems grouped into suites`)
  opening `/app/isa-demo/qos-benchmarks/collections`; no `Library` command.
- On `/app/isa-demo/qos-benchmarks/collections/checkout` the tab `Collections` is the current one and no `Library`
  pill navigation is shown.

**3. Entry points are gone**
- Case list: no `Open the library`. Case composer: no `Open in library`, `Find in library`, issue action `library`.
- Case revision: resource cards are plain, notes read `Published`, `Not published` or `Withdrawn`.
- Job launch and job detail: no `Edit the candidate`, `edit the candidates`, `Open the library`; `Engines` stays.
- Organization overview `/app/isa-demo`: no `Library` action.
- Study detail: no `Open the definition in the library`; the note reads `Definition version N · sealed`.
- Collection detail: resource pins are plain labels, not links.

**4. Automated checks (repository root, at the PR head)**
- `pnpm --dir frontend exec vitest run src/routes src/test src/components src/pages`. Expect all pass: 71 screens
  (D4 = 11), the seven ids absent, redirect and link-scan tests, allow-list ceiling 12.
- `pnpm --dir frontend exec playwright test e2e/s5b-library.spec.ts e2e/routes-smoke.spec.ts e2e/qa-gallery.spec.ts`.
  Expect the gallery to list 71 screens and the library smokes to land on the targets above.
- `openbinding-gateway/tests/test_b2_resolve_urls.py`: passes with the redirecting library version address listed.
