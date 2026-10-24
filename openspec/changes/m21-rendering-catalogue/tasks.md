# Tasks: m21-rendering-catalogue

Nothing is built. Each slice writes its tests first, in the same task as the code they cover, tagged
`[utest->req~frontend-rendering-<name>~1]`; the code carries `[impl->req~frontend-rendering-<name>~1]`. The check of
every slice is the frontend suite from the repository root, proposed as
`["pnpm", "--dir", "frontend", "exec", "vitest", "run", <paths>]` (the contract registers the exact argv). The
contracts are in design.md §2, the hygiene rule in design.md §4.

Order: S1, S2, S3 and S4 in one PR (M2.1 and M2.2 together, over the ~300-line guideline because the owner scoped the
change to both; design.md §8), then S5. S3 depends on S1 (the two exempt files must exist). S2 and S4 are independent
of each other.

Known deviations: no red_before (G3) run is recorded, because the registered check cannot accept import errors of
modules that do not exist yet as a red result; the evidence that each rule can fail is the scenarios' negative cases
and the detector controls. G1 (`["openspec", "validate", "m21-rendering-catalogue", "--strict"]`) is NOT run: owner
exemption until M0.3 (PR 37) puts the OpenSpec CLI in CI; the format was checked by reading against
`openspec/changes/m41-space-lab-profile/` and `openspec/changes/m05-pr-previews/`.

## S1. SourceView and LogPanel (tests first)
- [ ] 1.1 `frontend/src/components/rendering/SourceView.test.tsx`: the scenarios of `source-view` (string and object
  source, region name, tab order, Copy with accepting and rejecting clipboard, Download only with `filename`).
- [ ] 1.2 `frontend/src/components/rendering/SourceView.tsx` and `SourceView.css`, as design.md §2.
- [ ] 1.3 `frontend/src/components/rendering/LogPanel.test.tsx`: the scenarios of `log-panel` (closed by default,
  `defaultOpen`, summary count and singular, search and `N of M lines`, Copy of the whole log, Download only with
  `filename`, `No log`).
- [ ] 1.4 `frontend/src/components/rendering/LogPanel.tsx` and `LogPanel.css`.
- Acceptance: both test files pass; `frontend/src/hygiene.test.ts` still passes (no hex colours, tokens only).

## S2. DiagnosticsList, VerdictBadge and MetricCards (tests first)
- [ ] 2.1 `frontend/src/components/rendering/DiagnosticsList.test.tsx`, then `DiagnosticsList.tsx` and its CSS:
  grouping with `General`, severity order, fields as text, summary count, `headingLevel`, `No diagnostics`.
- [ ] 2.2 `frontend/src/components/rendering/VerdictBadge.test.tsx`, then `VerdictBadge.tsx` and its CSS: the five
  verdicts with the descriptions of design.md §2, reasons, unknown value neutral.
- [ ] 2.3 `frontend/src/components/rendering/MetricCards.test.tsx`, then `MetricCards.tsx` and its CSS: labelled list,
  formatted value, unit, trend text, em dash for `null`, string value.
- Acceptance: the three test files pass; `frontend/src/hygiene.test.ts` still passes.

## S3. Hygiene test and allow-list (after S1)
- [ ] 3.1 `frontend/src/test/rawRenderingHygiene.test.ts`: the detector of design.md §4 with its in-memory controls,
  failures (a) unlisted hit, (b) stale entry, (c) entry outside the 15 offender files, and the assertion that the
  offender numbers are exactly 1–15.
- [ ] 3.2 `frontend/src/test/rawRenderingAllowList.ts`: one or more entries per offender 1–15 of ROADMAP M2, with the
  trimmed line texts of the current files; detector hits outside the 15 in `UNLISTED_FINDINGS`, each with a note.
- [ ] 3.3 Report every `UNLISTED_FINDINGS` entry (file, text, why it is not one of the 15) in the result block for the
  coordinator.
- Acceptance: the hygiene test passes on the tree; adding `<pre>` to any other `.tsx` file makes it fail (shown by the
  controls, not by a committed change).

## S4. Catalogue documentation
- [ ] 4.1 `docs/qa/RENDERING_CATALOGUE.md`: the five components, their props, when to use each, the hygiene exemptions
  and how to remove an allow-list entry (design.md §5). This is the design-system documentation of ROADMAP M2.1:
  ARCHITECTURE §5.3 is the catalogue table and is owned by the coordinator, and no separate design-system document
  exists in scope.
- Acceptance: every component and prop of design.md §2 appears in the page.

## S5. Review, then archive later
- [ ] 5.1 Review of the PR (G11) and ui-qa, if the coordinator asks for screenshots of a gallery page.
- [ ] 5.2 Archive (separate, explicit archive task, not done here):
  `["openspec", "archive", "m21-rendering-catalogue", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`
  once the CLI is available.

## Follow-ups outside this change
- Coordinator: ARCHITECTURE §5.3 may point to `frontend/src/components/rendering/` and `docs/qa/RENDERING_CATALOGUE.md`.
- Owner: constitution 15 `Enforced:` line names `frontend/src/test/rawRenderingHygiene.test.ts` once S3 lands.
- M2.3–M2.6 remove allow-list entries; the slice that removes the first one relaxes "exactly 1–15" to "a subset of
  1–15" (design.md §4). M2.7 adds digest and UUID detection.
- An automated WCAG scan (`axe-core`) needs a dependency decision (constitution 11 GAP).
