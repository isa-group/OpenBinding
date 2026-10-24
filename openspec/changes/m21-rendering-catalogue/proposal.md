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

- Five shared rendering components under `frontend/src/components/rendering/`: `SourceView` (read-only source with
  Copy and optional Download), `LogPanel` (collapsed, searchable, copyable log), `DiagnosticsList` (diagnostics grouped
  by resource, errors first, with code, pointer and hint), `VerdictBadge` (the five run verdicts with a plain-language
  description and reasons) and `MetricCards` (labelled key numbers with unit and trend).
- Each component has unit and accessibility tests that query by Testing Library roles and accessible names.
- A hygiene test `frontend/src/test/rawRenderingHygiene.test.ts` fails on any new `<pre>` or rendered
  `JSON.stringify` outside `SourceView` and `LogPanel`.
- Its allow-list `frontend/src/test/rawRenderingAllowList.ts` lists the 15 offenders of ROADMAP M2 and may only shrink:
  an entry that no longer matches fails the test.
- A catalogue page `docs/qa/RENDERING_CATALOGUE.md` documents the five components, their props and when to use each.
- No screen changes in this change: the offenders are replaced in M2.3–M2.6.

## Impact

- Capability: `frontend-rendering` (new). Six ADDED requirements: `source-view`, `log-panel`, `diagnostics-list`,
  `verdict-badge`, `metric-cards` and `raw-hygiene`, all `~1`.
- Repository: new files only, `frontend/src/components/rendering/*.{tsx,css,test.tsx}`,
  `frontend/src/test/rawRenderingHygiene.test.ts`, `frontend/src/test/rawRenderingAllowList.ts` and
  `docs/qa/RENDERING_CATALOGUE.md`. No existing screen, no `package.json` and no lockfile change; no new dependency.
- ARCHITECTURE §5.3 is the catalogue table and is owned by the coordinator; this change does not edit it. ARCHITECTURE
  §5.1 places the catalogue under `shared/ui`; that layout does not exist yet, so the components go next to
  `components/ui` and move with it when the feature-sliced layout lands (design.md §1).
- No HTTP API, OpenAPI or database schema change. No production impact.
- Risks: the detector is a line-based text scan, so it can miss a `<pre>` split over lines in an unusual way or flag a
  non-rendering `JSON.stringify` in a `.tsx` file (design.md §4, §7); the second goes to `UNLISTED_FINDINGS`, not to
  the offender list. Accessibility is checked by roles and names only, with no automated WCAG scan (constitution 11 GAP).
- Deviation: one PR carries M2.1 and M2.2 together, over the ~300-line guideline (constitution 14.1), because the
  owner scoped this change to both. No red_before (G3) run is recorded (design.md §8).
- G1 (`openspec validate m21-rendering-catalogue --strict`) is NOT run: owner exemption until M0.3 (PR 37) puts the
  OpenSpec CLI in CI. The format was checked by reading against `openspec/changes/m41-space-lab-profile/` and
  `openspec/changes/m05-pr-previews/`.
- Order: S1, S2, S3, S4 in one PR, then S5 (tasks.md).

## Out of scope

- Replacing any of the 15 offenders (M2.3–M2.6) and the other catalogue components of ARCHITECTURE §5.3.
- Digest-shaped text and UUID detection in the hygiene test (M2.7).
- Syntax highlighting in `SourceView`, virtualised rendering of long logs, and any new dependency (axe-core,
  `@testing-library/user-event`, a highlighter).
- Editing ARCHITECTURE §5.3, ADR-0014 or constitution Article 15 (coordinator and owner).
- Archiving this change into `openspec/specs/frontend-rendering/` (separate, explicit archive task).
