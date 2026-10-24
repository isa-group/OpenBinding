# Tasks: m21-rendering-catalogue

S1, S2 and S3 are built and merged on the change branch; S4 and S5 are not done. Each slice wrote its tests in the
same task as the code they cover, tagged `[utest->req~frontend-rendering-<name>~1]`; the code carries
`[impl->req~frontend-rendering-<name>~1]`. The contracts are in design.md §2, the hygiene rule in design.md §4.

Registered checks used by S1–S3 (frontend directory, frozen install first):
- `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run src/components/rendering src/test/rawRenderingHygiene.test.ts'`
  (the five component test files and the hygiene test);
- eslint and tsc of the frontend in the same `bash -c 'cd frontend; pnpm install --frozen-lockfile; pnpm exec …'` form.

Order: S1, S2 and S3 in one PR (M2.1 and M2.2 together, over the ~300-line guideline because the owner scoped the
change to both; design.md §8), then S4, then S5. S3 depended on S1 (the two exempt files must exist).

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
  summary counts, grouping with `General` (separate from a resource named `General`), severity and group order, fields
  as text in a lowercase badge, `headingLevel`, sections named by their heading, `No diagnostics`.
- [x] 2.2 `frontend/src/components/rendering/VerdictBadge.test.tsx`, then `VerdictBadge.tsx` and its CSS: the five
  verdicts with the variants and descriptions of design.md §2 on a wrapper span, one id per instance, size, reasons,
  unknown value neutral.
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

## S4. Catalogue documentation (not done)
- [ ] 4.1 `docs/qa/RENDERING_CATALOGUE.md`: the five components, their props, when to use each, the hygiene exemptions
  and how to remove an allow-list entry (design.md §5). This is the design-system documentation of ROADMAP M2.1:
  ARCHITECTURE §5.3 is the catalogue table and is owned by the coordinator, and no separate design-system document
  exists in scope.
- Acceptance: every component and prop of design.md §2 appears in the page.

## S5. Review, then archive later (not done)
- [ ] 5.1 Review of the PR (G11) and ui-qa, if the coordinator asks for screenshots of a gallery page.
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
