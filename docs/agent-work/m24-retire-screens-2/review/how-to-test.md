# How to test: m24-retire-screens-2 (slice 2, report editor)

Change: `openspec/changes/m24-retire-screens-2`. The screens `/app/:org/:project/reports` and
`/app/:org/:project/reports/:report` are retired. Old addresses redirect to `/app/:org/:project/publications`, the
project tab `Reports` is now `Publications`, every entry point to the editor is gone, and the registry holds 78
screens (D6 = 8). The publications list and the verifier stay.

## Read this first: what could and could not be verified

- Preview: `http://127.0.0.1:18100` is the **develop** preview. It runs the develop build, which does **not** contain
  this change. It shows the OLD behaviour.
- The after-state steps below are therefore **not verified**. They can only be run once this change is on a preview.
  No after-state screenshot exists, and none was made up.
- The G13 guide check was **not run**. No step or example here is marked `verified (G13 run)`. The g13 captures are
  recorded by the coordinator after the merge, from the develop preview.
- Before-state captures (develop preview): **none captured**. This session had no browser, no screenshot tool and no
  network access to the preview. Planned names are listed per step.
- Playwright is not available in the lab where the specs were edited: **the edited specs were not run**. CI is the
  evidence for them.
- No API examples: the change touches no gateway endpoint (`req~frontend-retire-gateway-untouched~1`).

Demo account: the preview's demo user with the organization `isa-demo` (project `qos-benchmarks`). Sign in by name
on `/login`; no password is written here.

## UI steps

**1. The project tabs show Publications, not Reports**
- Go to `/app/isa-demo/qos-benchmarks` (signed in). Read the tab row under the project name, then press `Ctrl+K` and
  type `Publications`.
- Expect: tabs `Overview`, `Cases`, `Library`, `Studies`, `Publications`, `Files` (and the member-only ones for a
  member), no `Reports`. The command `Project › Publications` opens `/app/isa-demo/qos-benchmarks/publications`; there
  is no `Reports` command. On the publications screen the tab `Publications` is the current one.
- A public project of another organization (for example `/app/open-lab/open-bench`) shows the same public tabs with
  `Publications`.
- Mark: not verified: the change is not on the preview.
- Captures planned: `01-tabs-desktop.png`, `01-tabs-mobile.png`
  (before: `01-tabs-before-desktop.png`, `01-tabs-before-mobile.png`, label `before (develop preview)`).

**2. Old report addresses redirect**
Open each address in the address bar, signed in:

| Open | Expect the address to become |
|---|---|
| `/app/isa-demo/qos-benchmarks/reports` | `/app/isa-demo/qos-benchmarks/publications` |
| `/app/isa-demo/qos-benchmarks/reports/engine-comparison` | `/app/isa-demo/qos-benchmarks/publications` |
| `/app/isa-demo/qos-benchmarks/reports?filter=drafts` | `/app/isa-demo/qos-benchmarks/publications` (query dropped) |
| `/app/isa-demo/qos-benchmarks/reports/engine-comparison?x=1#top` | `/app/isa-demo/qos-benchmarks/publications` (query and hash dropped) |
| `/app/isa-demo/qos-benchmarks/reports/hallazgos%20de%20checkout` | `/app/isa-demo/qos-benchmarks/publications` (encoded slug) |
| `/app/isa-demo/library/reports` (negative: an artifact named `reports`) | stays on the library artifact `reports`; not redirected |

- Signed out first: open `/app/isa-demo/qos-benchmarks/reports/engine-comparison` with no session. Expect `/login`,
  and after signing in the publications address above.
- Expect also: the browser Back button returns to the page you came from, not to the old address (the history entry is
  replaced); no heading `Reports` and no report editor.
- Mark: not verified: the change is not on the preview.
- Captures planned: `02-redirect-list-desktop.png`, `02-redirect-slug-desktop.png`, `02-redirect-slug-mobile.png`
  (before: `02-report-editor-before-desktop.png`, `02-report-list-before-desktop.png`, label `before (develop preview)`).

**3. The entry points to the editor are gone**
- Project overview `/app/isa-demo/qos-benchmarks`: no `Reports` card, no `All reports`, no `New report`.
- A job detail (`/app/jobs`, open a completed job), region `Where this result comes from`: no `Add to a report`.
- A study run and its `Compare results` page: no `Create a report`, no `Open the report`.
- Mark: not verified: the change is not on the preview.
- Captures planned: `03-overview-desktop.png`, `03-job-detail-desktop.png`, `03-study-run-desktop.png`,
  `03-study-analytics-desktop.png`, `03-overview-mobile.png`.

**4. Publications and the verifier still work**
- `/app/isa-demo/qos-benchmarks/publications`: lists the editions with their citation, `Open public verification`
  (to `/resolve/report/<digest>`) and `Withdraw` for a member; no `Open the report` link. The empty project
  (`/app/isa-demo/checkout-privado/publications`) says `Nothing published yet` and names no report page.
- `/app/verifier?digest=<fingerprint of a published edition>`: the verdict is `Verified`, and the match of the report
  links to `/app/isa-demo/qos-benchmarks/publications` with the label `Open`; `Public record` still opens
  `/resolve/report/<digest>`.
- Mark: not verified: the change is not on the preview.
- Captures planned: `04-publications-desktop.png`, `04-publications-mobile.png`, `04-verifier-desktop.png`.

**5. Automated checks (run these from the repository, at the PR head)**
- `pnpm --dir frontend exec vitest run src/routes src/test`. Expect: all pass; the route registry counts 78 screens
  (D6 = 8), `rep-list` and `rep-detail` are absent, the redirect table and link scan tests pass, and the raw-rendering
  allow-list ceiling is 13.
- The Playwright spec `s7b-reports` (`pnpm --dir frontend exec playwright test e2e/s7b-reports.spec.ts`), and
  `s6a-jobs`, `s7a-studies`, `s4b-project`, `qa-gallery` and `routes-smoke`. Expect: they pass without opening or
  expecting a retired address; the gallery lists 78 screens; the smoke step opens
  `/app/isa-demo/qos-benchmarks/reports/engine-comparison` and lands on `/app/isa-demo/qos-benchmarks/publications`.
- Mark: not verified: not run by this guide's author (no Playwright in the lab); CI is the evidence.

## For ui-qa

Take the before captures above on the develop preview, and the after captures once the change is on the develop
preview (the g13 captures are recorded by the coordinator after the merge). Do not reuse a before capture as an after
capture.
