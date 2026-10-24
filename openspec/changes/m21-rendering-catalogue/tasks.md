# Tasks: m21-rendering-catalogue

S1, S2, S3 and S4 are built and merged on the change branch, including the fixes of review round 1 of PR 38 (R1
below); S5 (review sign-off and archive) is open. Each slice wrote its tests in the
same task as the code they cover, tagged `[utest->req~frontend-rendering-<name>~1]`; the code carries
`[impl->req~frontend-rendering-<name>~1]`. The contracts are in design.md §2, the hygiene rule in design.md §4.

Registered checks used by S1–S3 (frontend directory, frozen install first):
- `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run src/components/rendering src/test/rawRenderingHygiene.test.ts'`
  (the five component test files and the hygiene test);
- eslint and tsc of the frontend in the same `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec …'` form.

Order: S1, S2 and S3 in one PR (M2.1 and M2.2 together, over the ~300-line guideline because the owner scoped the
change to both; design.md §8), with S4, then S5. S3 depended on S1 (the two exempt files must exist).

Known deviations: no red_before (G3) run is recorded, because the registered check cannot accept import errors of
modules that do not exist yet as a red result; the evidence that each rule can fail is the scenarios' negative cases
and the detector controls. G1 (`["openspec", "validate", "m21-rendering-catalogue", "--strict"]`) is NOT run: owner
exemption until M0.3 (PR 37) puts the OpenSpec CLI in CI; the format was checked by reading against
`openspec/changes/m41-space-lab-profile/`.

## S1. SourceView and LogPanel (tests first)
- [x] 1.1 `frontend/src/components/rendering/SourceView.test.tsx`: the scenarios of `source-view` (string and object
  source, `Empty`, `data-language`, region name, Copy with accepting and rejecting clipboard and its status text,
  Download only with `filename` and its blob type, keyboard reach, `maxHeight`, no hex colour).
- [x] 1.2 `frontend/src/components/rendering/SourceView.tsx` and `SourceView.css`, as design.md §2.
- [x] 1.3 `frontend/src/components/rendering/LogPanel.test.tsx`: the scenarios of `log-panel` (closed by default,
  `defaultOpen`, summary count and singular, `No log`, numbered lines, case-insensitive search and `N of M lines`,
  `No lines match`, Copy of the whole log, Download only with `filename`, keyboard reach, scrolling, no hex colour).
- [x] 1.4 `frontend/src/components/rendering/LogPanel.tsx` and `LogPanel.css`.
- Acceptance: both test files pass; `frontend/src/hygiene.test.ts` still passes.

## S2. DiagnosticsList, VerdictBadge and MetricCards (tests first)
- [x] 2.1 `frontend/src/components/rendering/DiagnosticsList.test.tsx`, then `DiagnosticsList.tsx` and its CSS:
  summary counts, grouping with `General` (separate from a resource named `General`), severity and group order
  (pointer groups inside a resource since R1.4), fields
  as text in a lowercase badge, `headingLevel`, sections named by their heading, `No diagnostics`.
- [x] 2.2 `frontend/src/components/rendering/VerdictBadge.test.tsx`, then `VerdictBadge.tsx` and its CSS: the five
  verdicts with the variants and descriptions of design.md §2 (since R1.5 as hidden in-flow text, outer `<div>`), size,
  reasons, unknown value neutral.
- [x] 2.3 `frontend/src/components/rendering/MetricCards.test.tsx`, then `MetricCards.tsx` and its CSS: list named
  `Key figures` or `label`, `dl` cards, en-US number format, string value, dash and `no value` for `null`, trend text,
  hint, ids, nothing for no metrics.
- Acceptance: the three test files pass; `frontend/src/hygiene.test.ts` still passes.

## S3. Hygiene test and allow-list (after S1)
- [x] 3.1 `frontend/src/test/rawRenderingHygiene.test.ts`: the detector of design.md §4 with its in-memory controls,
  the exemption of exactly the two catalogue files, failures (a) unlisted finding, (b) stale entry, (c) wrong line
  number, and the allow-list shape (`MAX_ALLOWED_OFFENDERS` 15, offender numbers exactly 1–15, `retiredBy` per slice,
  unlisted findings with `UNLISTED_REASON` and `retiredBy: null`).
- [x] 3.2 `frontend/src/test/rawRenderingAllowList.ts`: one entry per offender 1–15 of ROADMAP M2 with paths under
  `frontend/src`, the current line numbers and trimmed texts, a reason and `retiredBy`; the two detector findings
  outside the 15 in `UNLISTED_FINDINGS` (16 `pages/Workbench/SourcePanel.tsx:108`, 17
  `pages/Analysis/SavedDecision.tsx:34`).
- [x] 3.3 Report the `UNLISTED_FINDINGS` entries to the coordinator for classification (still open: they have no
  retiring slice).
- Acceptance: the hygiene test passes on the tree; the controls show that a `<pre>` or rendered `JSON.stringify` in any
  other file is reported.

## S4. Catalogue documentation
- [x] 4.1 `docs/qa/RENDERING_CATALOGUE.md`: the five components, their props, when to use each, the hygiene exemptions,
  the detector's known limits and how to remove an allow-list entry (design.md §5). This is the design-system
  documentation of ROADMAP M2.1: ARCHITECTURE §5.3 is the catalogue table and is owned by the coordinator, and no
  separate design-system document exists in scope.
- Acceptance: every component and prop of design.md §2 appears in the page.

## R1. Fixes of review round 1 (PR 38)
- [x] R1.1 `components/rendering/download.ts`: one `saveText` helper for `SourceView` and `LogPanel`; the object URL is
  revoked in `setTimeout(…, 0)` after the click (tests use fake timers).
- [x] R1.2 `LogPanel`: status `1 of 1 line` for one line; Copy and Download buttons of both components at
  `min-height: 24px`.
- [x] R1.3 `MetricCards`: key `id`, or label plus position; same labels without ids render without a key warning.
- [x] R1.4 `DiagnosticsList`: inside a resource, items with the same pointer stay together, pointer groups in order of
  first appearance after the severity sort, items without a pointer in their own group (constitution 15.3).
- [x] R1.5 `VerdictBadge`: no `aria-describedby`; the description is visually hidden text `, <description>` right after
  the verdict in the badge flow; the outer element is a `<div>`.
- [x] R1.6 Hygiene: detector reports a child expression alone on its line and a rendered template-literal child, skips
  JSX comment lines; matching is a multiset per (file, text); `unlistedFindings`, `staleEntries` and
  `wrongLineNumbers` are exported and tested with synthetic inputs; the remaining limits are pinned by `known limit:`
  tests (design.md §4); offender 5's reason names `sourceText` (:77, shown in the textarea at :317) and the copy
  handler (:329).
- [x] R1.7 Spec delta, design.md and `docs/qa/RENDERING_CATALOGUE.md` updated to the built behaviour; the six
  requirement ids stay at revision 1 (unreleased).

## S5. Review, then archive later (open)
- [ ] 5.1 Review sign-off of the PR (G11) after round 1, and ui-qa if the coordinator asks for screenshots of a gallery
  page.
- [ ] 5.2 Archive (separate, explicit archive task, not done here):
  `["openspec", "archive", "m21-rendering-catalogue", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`
  once the CLI is available.

## Follow-ups outside this change
- Coordinator: classify `UNLISTED_FINDINGS` 16 and 17 (which slice retires them, or whether ROADMAP's list grows).
- Coordinator: ARCHITECTURE §5.3 may point to `frontend/src/components/rendering/` and `docs/qa/RENDERING_CATALOGUE.md`.
- Owner: constitution 15 `Enforced:` line names `frontend/src/test/rawRenderingHygiene.test.ts`.
- M2.3–M2.6 remove allow-list entries; the slice that removes the first one lowers `MAX_ALLOWED_OFFENDERS` and relaxes
  "exactly 1–15" to "a subset of 1–15" (design.md §4). M2.7 adds digest and UUID detection.
- An automated WCAG scan (`axe-core`) needs a dependency decision (constitution 11 GAP).
- M2.3: map the API `Termination` values `INFEASIBLE` and `UNKNOWN` (`frontend/src/api/client.ts`) to `VerdictBadge`
  verdicts; today `INFEASIBLE` (and `UNKNOWN`) render as a neutral `default` badge without description.
- Coordinator: confirm whether the 24 px minimum target of constitution 11.2 applies on desktop (the Copy and
  Download buttons follow it; nothing tests it).
