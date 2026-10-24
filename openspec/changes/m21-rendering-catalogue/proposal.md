# Change: m21-rendering-catalogue

## Why

ROADMAP M2.1: "Rendering catalogue foundations: `SourceView`, `LogPanel`, `DiagnosticsList`, `VerdictBadge`,
`MetricCards`", accepted when there are "components with unit and accessibility tests; documented in the design
system". ROADMAP M2.2: "Hygiene test with a shrinking allow-list of today's offenders", accepted when the "test fails
on any new raw rendering; allow-list lists the 15 offenders below". ADR-0014 (render, never dump) and constitution
Article 15 require every domain object to be rendered with the catalogue of ARCHITECTURE §5.3, raw sources only in
`SourceView`, logs only in a collapsed, searchable `LogPanel`, and a hygiene test that forbids `JSON.stringify` output
or `<pre>` outside those two components. Constitution 15 marks that test as a GAP today, and INTENT O5 counts the 15
raw-rendering offenders found at 912648c. M2.3–M2.6 replace the offenders with these components, and M3 starts when
the components exist.

## What Changes

State: the components, their tests, the hygiene test with its allow-list and the catalogue page are built (S1–S4),
with the fixes of review round 1 of PR 38; the review sign-off and the archive (S5) are open (tasks.md).

- Five shared rendering components under `frontend/src/components/rendering/`: `SourceView` (read-only source in a
  named region with Copy and optional Download), `LogPanel` (collapsed, searchable, copyable log with line numbers),
  `DiagnosticsList` (diagnostics grouped by resource and, inside a resource, by pointer, errors first, with a lowercase
  severity badge, code, pointer and hint, and a count summary), `VerdictBadge` (the five run verdicts with a
  plain-language description as visually hidden text after the verdict, and reasons) and `MetricCards` (labelled key
  figures with unit, trend and hint). `SourceView` and `LogPanel` share one download helper, `download.ts`.
- Each component has unit and accessibility tests that query by Testing Library roles, accessible names and
  descriptions, and a check that its stylesheet holds no hex colour.
- A hygiene test `frontend/src/test/rawRenderingHygiene.test.ts` with a line-based detector fails on any new `<pre>`
  tag or rendered `JSON.stringify` (a JSX child, a child alone on its line, a rendered template-literal child or a
  bare attribute value) outside `SourceView` and `LogPanel`. Its known limits are pinned by `known limit:` tests.
- Its allow-list `frontend/src/test/rawRenderingAllowList.ts` lists the 15 offenders of ROADMAP M2 (paths under
  `frontend/src`, matched as a multiset by file and trimmed line text, with the line number kept correct by a test)
  and may only shrink: an entry that no longer matches fails the test. Two detector findings that ROADMAP does not list
  are kept apart in `UNLISTED_FINDINGS` for the coordinator to classify.
- A catalogue page `docs/qa/RENDERING_CATALOGUE.md` documents the five components, their props, when to use each and
  the detector's limits.
- No screen changes in this change: the offenders are replaced in M2.3–M2.6.

## Impact

- Capability: `frontend-rendering` (new). Six ADDED requirements: `source-view`, `log-panel`, `diagnostics-list`,
  `verdict-badge`, `metric-cards` and `raw-hygiene`, all `~1`.
- Repository: new files only, `frontend/src/components/rendering/*.{tsx,css,test.tsx}` and `download.ts`,
  `frontend/src/test/rawRenderingHygiene.test.ts`, `frontend/src/test/rawRenderingAllowList.ts` and
  `docs/qa/RENDERING_CATALOGUE.md`. No existing screen, no `package.json` and no lockfile change; no new dependency.
- ARCHITECTURE §5.3 is the catalogue table and is owned by the coordinator; this change does not edit it. ARCHITECTURE
  §5.1 places the catalogue under `shared/ui`; that layout does not exist yet, so the components go next to
  `components/ui` and move with it when the feature-sliced layout lands (design.md §1).
- No HTTP API, OpenAPI or database schema change. No production impact.
- Risks: the detector is a line-based text scan with known limits (an apostrophe in JSX text, a template literal inside
  a larger child expression, a `JSON.stringify` on a different line from its opening `{`, a call wrapped in an
  attribute value) and misses raw rendering built without the literal `<pre` or `JSON.stringify(` (design.md §4, §7).
  Accessibility is checked by roles, names and descriptions only, with no automated WCAG scan (constitution 11 GAP).
- Findings for the coordinator: `UNLISTED_FINDINGS` 16 (`pages/Workbench/SourcePanel.tsx:108`, a diff `<pre>`) and 17
  (`pages/Analysis/SavedDecision.tsx:34`, a stringified reference) have `retiredBy: null` until classified. Offender 5
  lists only `RepDetail.tsx:326`: ROADMAP's :77 (`sourceText`, shown in the textarea at :317 through a variable the
  detector does not see) and :329 (a copy handler) are not flagged. `VerdictBadge` does not yet know the API
  `Termination` values `INFEASIBLE` and `UNKNOWN` (M2.3 maps them).
- Deviation: one PR carries M2.1 and M2.2 together, over the ~300-line guideline (constitution 14.1), because the
  owner scoped this change to both. No red_before (G3) run is recorded (design.md §8).
- G1 (`openspec validate m21-rendering-catalogue --strict`) is NOT run: owner exemption until M0.3 (PR 37) puts the
  OpenSpec CLI in CI. The format was checked by reading against `openspec/changes/m41-space-lab-profile/` and
  `openspec/changes/m05-pr-previews/`.
- Order: S1–S4 built in one PR, with review round 1 fixes (R1); then S5 (tasks.md).

## Out of scope

- Replacing any of the 15 offenders (M2.3–M2.6) and the other catalogue components of ARCHITECTURE §5.3.
- Digest-shaped text and UUID detection in the hygiene test (M2.7).
- Syntax highlighting in `SourceView`, virtualised rendering of long logs, and any new dependency (axe-core,
  `@testing-library/user-event`, a highlighter).
- Editing ARCHITECTURE §5.3, ADR-0014 or constitution Article 15 (coordinator and owner).
- Archiving this change into `openspec/specs/frontend-rendering/` (separate, explicit archive task).
