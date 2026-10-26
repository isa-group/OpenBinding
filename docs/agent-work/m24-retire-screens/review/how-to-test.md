# How to test: m24-retire-screens (slice 1, decision-space workspace)

Change: `openspec/changes/m24-retire-screens`. The screens `/app/analysis` and `/app/analysis/workspace` are retired.
Old addresses redirect, every link to them is gone, and the registry holds 80 screens.

## Read this first: what could and could not be verified

- Preview: `http://127.0.0.1:18100` is the **develop** preview. It runs the develop build, which does **not** contain
  this change. It shows the OLD behaviour. PR previews do not exist yet.
- The after-state steps below are therefore **not verified**. They can only be run once this change is on a preview.
  No after-state screenshot exists, and none was made up.
- The G13 guide check is not registered for this task (no check index available), so it was **not run**. No step or
  example here is marked `verified (G13 run)`.
- Before-state captures (old Analysis entry and screen on the develop preview): **none captured**. This session had no
  browser, no screenshot tool and no network access to the preview. Planned names are listed per step. Label them
  `before (develop preview)` when ui-qa takes them.
- No API examples: the change touches no gateway endpoint (`req~frontend-retire-gateway-untouched~1`). The negative
  case is the "Look-alike / unknown" row in step 2.

Demo account: the preview's demo user with the organization `isa-demo` (project `qos-benchmarks`). Sign in by name
on `/login`; no password is written here.

## UI steps

**1. The header and the mobile menu have no Analysis**
- Go to `http://127.0.0.1:18100/app/jobs` (signed in). Desktop: read the main navigation. Mobile (width 390): open the
  menu.
- Expect: links `Dashboard`/`Home`, `Jobs`, `Explore`, and `Admin` for an administrator, in the old order, and no
  `Analysis`. Press `Ctrl+K` (command palette), type `Analysis`: no `Go to › Analysis` command.
- Today on develop you see the `Analysis` entry and command (before state).
- Mark: not verified: the change is not on the preview.
- Captures planned: `01-navigation-desktop.png`, `01-navigation-mobile.png`
  (before: `01-navigation-before-desktop.png`, `01-navigation-before-mobile.png`, label `before (develop preview)`).

**2. Old addresses redirect and keep no query**
Open each address in the address bar while signed in:

| Open | Expect the address to become |
|---|---|
| `/app/analysis` | `/app/jobs` |
| `/app/analysis/workspace?job=x` | `/app/jobs` |
| `/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=run-1` | `/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds/runs/run-1` |
| `/app/analysis/workspace?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds` | `/app/isa-demo/qos-benchmarks/studies/engines-vs-seeds` |
| `/app/analysis?org=isa-demo&project=qos-benchmarks&run=run-1` (negative: run without study) | `/app/jobs` |

- Expect also: no heading `Analysis` or `Decision space`; the browser Back button returns to the page you came from,
  not to the old address (the history entry is replaced). Signed out, the same address shows `/login` first and then
  the target.
- Mark: not verified: the change is not on the preview.
- Captures planned: `02-redirect-jobs-desktop.png`, `02-redirect-study-desktop.png`, `02-redirect-jobs-mobile.png`
  (before: `02-analysis-screen-before-desktop.png`, `02-analysis-screen-before-mobile.png`: the old `/app/analysis`
  screen, label `before (develop preview)`).

**3. Job pages have no Analyze action**
- Go to `/app/jobs`, select the completed job `job-done-3` (list), then open its detail and the job history.
- Expect: no link or button named `Analyze`, `Analyze 1 selected` or `Open analysis` (the last one also on the binding
  card of a job). On a study run analytics page: no `Weigh trade-offs`.
- Mark: not verified: the change is not on the preview.
- Captures planned: `03-job-detail-desktop.png`, `03-job-list-desktop.png`, `03-job-list-mobile.png`.

**4. A saved decision's report has no reopen link**
- Go to the report page of a report that holds a decision (for example `isa-demo/qos-benchmarks/decision-choice`).
- Expect: the decision is shown as text and no link `Reopen decision space`. A reference the page cannot read shows
  `unrecognised reference` instead of raw data.
- Mark: not verified: the change is not on the preview.
- Captures planned: `04-report-decision-desktop.png`, `04-report-decision-mobile.png`.

**5. Automated checks (run these from the repository, at the PR head)**
- `pnpm --dir frontend exec vitest run src/routes src/test`. Expect: all pass; the route registry counts 80 screens
  (D6 = 10), `analysis-sources` and `analysis-workspace` are absent, the redirect table and link scan tests pass, and
  the raw-rendering allow-list ceiling is 14.
- The Playwright spec `s7b-reports` (`pnpm --dir frontend exec playwright test e2e/s7b-reports.spec.ts`). Expect: it
  passes without opening or expecting a retired address.
- Mark: not verified: not run by this guide's author (no registered check, no shell).

## For ui-qa

Take the before captures above on the develop preview, and the after captures once the PR is on a preview. Do not
reuse a before capture as an after capture.
