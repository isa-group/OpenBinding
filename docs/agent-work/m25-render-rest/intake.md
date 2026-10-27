# Intake: m25-render-rest (ROADMAP M2.5)

- Request: own-c65a4d8c96984360936bc2c1044b9a5b (2026-10-27). Planning record only: each slice below is its own
  OpenSpec change and its own PR into `develop`.
- Base read: `task/6da08ee7c9784073` at `00f653ef`.
- Request body: the inbox file named in the brief,
  `docs/agent-work/inbox/2026-10-27-own-c65a4d8c96984360936bc2c1044b9a5b-add_request.md`, is not in this worktree,
  and the request id appears in no repository file. This plan therefore follows the brief text and ROADMAP M2.5 only
  (see "Open questions").

## Goal and acceptance

ROADMAP M2.5: "Studies, engines, audit, registration and generator rendered; raw views moved to Source tabs".
Acceptance: offenders 8–10 and 12–15 removed from the raw-rendering allow-list. Constitution Article 15 (15.1 nothing
raw as main content; 15.2 source only as a secondary labelled tab or a download, through the catalogue's read-only
viewer `SourceView`; 15.4 details behind tabs or disclosure). ADR-0014.

## The seven offenders today (`frontend/src/test/rawRenderingAllowList.ts`)

| # | File (under `frontend/src`) | Line | What is raw | Capability |
|---|---|---|---|---|
| 8 | `pages/Studies/StudyCell.tsx` | 296 | `<pre>` of cell metrics JSON inside `<details>View source` | studies |
| 9 | `pages/Studies/StudyDetail.tsx` | 276 (ROADMAP says 277) | `<pre>` of the study definition JSON inside `<details>` | studies |
| 10 | `pages/Engines/EngineParts.tsx` | 47 | `ViewSource` helper: `<pre>` of `JSON.stringify(value)`; used by `ManifestPanel` (EngRegistrationDetail), `LangExtensions`, `RegisterEngine` (review step), `AdminAudit`, `AdminErrors`, `AdminEngineReview` | engines |
| 12 | `pages/Organization/OrgAudit.tsx` | 88 | audit detail values: `JSON.stringify(value)` for non-strings | audit |
| 13 | `pages/RegisterEngine/EngineForm.tsx` | 179 | fixed option: `<code>{JSON.stringify(option.rest)}</code>` | registration |
| 14 | `pages/Generator/LabAside.tsx` | 25 | generated file text in a bare `<pre>` inside `<details>View source` | generator |
| 15 | `pages/Cases/SnapshotDetail.tsx` | 94 | `CodeEditor value={JSON.stringify(snapshot.ir.document)}` inside `<details>View source` | snapshot (source) |

All seven screens already render their main content; what remains is the source view (8, 9, 10, 14, 15) and two
stringified values (12, 13). No HTTP API, OpenAPI, gateway, worker or database change is needed in any slice.

## Cross-cutting decisions

1. **The allow-list is a shared ledger, so it is split first (slice S0).** Every retirement today edits the same three
   places: its entry in `rawRenderingAllowList.ts`, `MAX_ALLOWED_OFFENDERS`, and the exact-list and ceiling assertions in
   `rawRenderingHygiene.test.ts` (lines 361–408). A stale entry makes the hygiene test fail, so a slice cannot retire
   its offender without editing them. Two parallel slices would always conflict there, and M2.3 (offenders 1–4) and M2.6
   (offender 6) edit the same lines. S0 gives each offender its own entry file, so each retiring slice deletes only its
   own file. Fallback if S0 is rejected: S1–S6 build in parallel, but their final "ledger" task runs strictly one after
   another in merge order, each after the previous PR merged (see "Open questions").
2. **Source tab vs disclosure.** On a page that is the item's own page (study, cell, snapshot, engine registration),
   the source moves to a real `Source` tab (`components/ui/TabBar` + `TabPanel`, read-only) with `SourceView`, beside
   an `Overview`/`Result` tab that stays the default. Inside a card, side panel, list row or wizard step (generator
   preview, register review step, language-extension rows, admin asides), a collapsed, labelled disclosure that holds
   `SourceView` stands in for the tab (constitution 15.4 "details behind tabs or disclosure"). This reading of 15.2 needs
   confirming (open question 2).
3. **No new shared component.** Slices use `SourceView` (M2.1) and, where useful, `MetricCards` (M2.1) read-only.
   Nothing is added under `frontend/src/components/rendering/**`: M2.3 owns that folder while it builds
   `BindingTable` etc. and maps `INFEASIBLE`/`UNKNOWN` in `VerdictBadge`.
4. **No feature flag.** Each slice leaves its screens complete and consistent on its own; nothing spans slices.
5. **Tests first in every slice.** A test-designer task writes the failing page tests plus the retirement assertion
   and proves them red with a `red_before` check (G3). The implementer task follows, then the review.
6. **Shared docs at the end.** `docs/qa/RENDERING_CATALOGUE.md` (offender table, counts) and the M2 status paragraph
   of `ROADMAP.md` belong to the closing slice S7, so no parallel slice touches them. S0 alone edits the "Hygiene
   test" section of the catalogue, and it runs before S7.

## Slices

Defaults: frontend only; roles test-designer → implementer → reviewer panel by risk; model and effort as the role
defaults unless stated. Each change folder `openspec/changes/<id>/**` (proposal, design, tasks, delta spec of
capability `frontend-rendering`) belongs to its slice. Requirement ids are proposals for the specifier.

### S0 `m25-allow-list-ledger` (sequential, first; risk medium)
- Why medium: it changes the guard that enforces Article 15. The delta replaces the ceiling scenarios of the unarchived
  `m21-rendering-catalogue` and `m24-retire-*` changes, so their archive needs reconciling.
- Owns: `frontend/src/test/rawRenderingAllowList.ts`, `frontend/src/test/rawRenderingAllowList/**` (new),
  `frontend/src/test/rawRenderingDetector.ts` (new), `frontend/src/test/rawRenderingHygiene.test.ts`,
  `docs/qa/RENDERING_CATALOGUE.md` ("Hygiene test" section only), `openspec/changes/m25-allow-list-ledger/**`.
- Content: one entry file per remaining offender, `rawRenderingAllowList/offender-NN.ts` (1, 2, 3, 4, 6, 8, 9, 10,
  12, 13, 14, 15), assembled with `import.meta.glob(..., { eager: true })`. The scanned sources already exclude
  `src/test/**`. A frozen table `ROADMAP_OFFENDERS` holds the 15 ROADMAP rows (number, file, `retiredBy`) and never
  changes. Invariants: every entry matches its row (file and `retiredBy`); numbers are unique; the file name carries
  the number. These replace `MAX_ALLOWED_OFFENDERS` and the per-slice exact-list assertions. `UNLISTED_FINDINGS`
  (finding 16) stays in `rawRenderingAllowList.ts`. The detector functions (`findRawRendering`, `unlistedFindings`,
  `staleEntries`, `wrongLineNumbers`) move to `rawRenderingDetector.ts`, a module that is not a test file, so other
  test files can import them. Two new helpers, `allowListEntriesFor(file)` and `rawFindingsIn(file)`, let each slice
  prove its retirement in its own test file.
- Requirements: `req~frontend-hygiene-ledger-entries~1`, `req~frontend-hygiene-ledger-frozen-table~1`,
  `req~frontend-hygiene-ledger-retirement-helpers~1`. Unchanged detector behaviour is pinned by the existing synthetic
  tests.
- Size: about 250 lines, mostly the detector move (justified: a move, no new logic). Turn budget 60.
- Risk accepted (as in m21 design §7 for `UNLISTED_FINDINGS`): re-adding a deleted entry file is caught by review, not
  by the test.

### S1 `m25-render-studies` (parallel after S0; risk low) — offenders 8, 9
- Owns: `frontend/src/pages/Studies/StudyCell.tsx`, `StudyDetail.tsx`, `Studies.css`, `parts.tsx`,
  `StudyCell.test.tsx`, `StudyDetail.test.tsx`, `frontend/e2e/s7a-studies.spec.ts`,
  `frontend/src/test/rawRenderingAllowList/offender-08.ts`, `offender-09.ts` (deleted), `openspec/changes/m25-render-studies/**`.
- Content: both pages get tabs (`Result`/`Overview` default, `Source`). The Source tab holds `SourceView`: for the
  cell, the same object as today (state, job, engine, parameters, seed, metrics); for the study, the definition. Each
  has a filename for download. The `st-source` disclosure goes. Existing tests at `StudyCell.test.tsx:259` and
  `StudyDetail.test.tsx:73`, and e2e `s7a-studies.spec.ts:606,827`, move to the tab.
- Requirements: `req~frontend-studies-source-tab~1`, `req~frontend-studies-leave-allow-list~1`. About 180 lines.
  Turn budget 50.

### S2 `m25-render-engines` (parallel after S0; risk medium) — offender 10
- Why medium: `ViewSource` has six consumers across engines, registration and administration screens and three e2e specs.
- Owns: `frontend/src/pages/Engines/EngineParts.tsx`, `EngineParts.css`, `EngRegistrationDetail.tsx`,
  `EngRegistrationDetail.test.tsx`, `LangExtensions.tsx`, `LangExtensions.test.tsx`,
  `frontend/src/pages/Admin/AdminAudit.test.tsx`, `AdminErrors.test.tsx`, `AdminEngineReview.test.tsx` (only if
  their assertions break), `frontend/e2e/s8a-engines.spec.ts`, `frontend/e2e/s9a-admin.spec.ts` (only if needed),
  `frontend/src/test/rawRenderingAllowList/offender-10.ts` (deleted), `openspec/changes/m25-render-engines/**`.
- Content: `ViewSource` keeps its export and its `View source` summary but renders `SourceView` (no `<pre>`, no
  stringify), so all consumers use the catalogue viewer. `ManifestPanel` on the registration detail gets a
  `Manifest`/`Source` tab pair. Language-extension rows keep the disclosure (decision 2). Admin source files are not
  edited; only their tests, if needed.
- Requirements: `req~frontend-engines-source-view~1`, `req~frontend-engines-manifest-source-tab~1`,
  `req~frontend-engines-leave-allow-list~1`. About 250 lines. Turn budget 70.
- Order: if it needs `s9a-admin.spec.ts`, it starts after `m24-retire-sponsorship` merges (that PR edits the same spec).

### S3 `m25-render-audit` (parallel after S0; risk low) — offender 12
- Owns: `frontend/src/pages/Organization/OrgAudit.tsx`, `auditModel.ts`, `auditModel.test.ts` (new),
  `OrgAudit.test.tsx`, `Organization.css` (audit rules only), `frontend/e2e/s4a-org.spec.ts`,
  `frontend/src/test/rawRenderingAllowList/offender-12.ts` (deleted), `openspec/changes/m25-render-audit/**`.
- Content: a pure `detailRows(event)` in `auditModel.ts` turns detail values into typed rows. Strings stay as they
  are; numbers and booleans are formatted; arrays become lists; objects become nested definition lists with readable
  keys; `null` shows "none". No stringify. The CSV export keeps its JSON column (download, allowed).
- Requirements: `req~frontend-audit-detail-rendered~1`, `req~frontend-audit-leave-allow-list~1`. About 150 lines.
  Turn budget 40.

### S4 `m25-render-registration` (parallel after S0; risk low) — offender 13
- Owns: `frontend/src/pages/RegisterEngine/EngineForm.tsx`, `engineDraft.ts`, `RegisterEngine.css`,
  `RegisterEngine.test.tsx`, `frontend/src/pages/Engines/manifestModel.ts`, `manifestModel.test.ts`,
  `frontend/src/test/rawRenderingAllowList/offender-13.ts` (deleted), `openspec/changes/m25-render-registration/**`.
- Content: a fixed option reads like the manifest view: "always tabu" or "one of a, b". This reuses the `const`/`enum`
  logic of `manifestModel.readOptions`, exported as one helper. Any other schema keywords appear as a short
  keyword/value list. S2 does not edit `manifestModel.ts`; it only imports from it.
- Requirements: `req~frontend-registration-fixed-option-rendered~1`, `req~frontend-registration-leave-allow-list~1`.
  About 120 lines. Turn budget 40.

### S5 `m25-render-generator` (parallel after S0; risk low) — offender 14
- Owns: `frontend/src/pages/Generator/LabAside.tsx`, `Generator.css`, `GeneratorLab.test.tsx`,
  `frontend/src/test/rawRenderingAllowList/offender-14.ts` (deleted), `openspec/changes/m25-render-generator/**`.
- Content: the preview keeps its `View source` disclosure and `File` combobox (decision 2), and the chosen file shows
  in `SourceView` with copy and download under its own name. It must not need `frontend/e2e/s5d-workbench.spec.ts`
  (gen-lab test at :570–:656, which clicks `View source` and reads `File`): M2.3 edits that spec for the workbench run
  views. If an e2e change turns out to be needed, the slice waits for M2.3's workbench slice to merge and then takes
  the spec.
- Requirements: `req~frontend-generator-files-source-view~1`, `req~frontend-generator-leave-allow-list~1`. About
  100 lines. Turn budget 35.

### S6 `m25-render-snapshot` (parallel after S0; risk low) — offender 15
- Owns: `frontend/src/pages/Cases/SnapshotDetail.tsx`, `SnapshotDetail.test.tsx`,
  `frontend/src/pages/Platform/SnapshotPage.css`, `frontend/e2e/s5a-cases.spec.ts`,
  `frontend/src/test/rawRenderingAllowList/offender-15.ts` (deleted), `openspec/changes/m25-render-snapshot/**`.
- Content: the page gets `Overview` (default: fingerprints, language, what engines receive, downloads) and `Source`
  tabs. Inside Source, the existing choice "Compiled form" / "Files in the package" stays. The compiled form is
  `SourceView source={snapshot.ir.document}` (an object, no stringify). The chosen package file is `SourceView` too,
  replacing the read-only `CodeEditor`. The archive still loads only when the Files view opens. Tests at
  `SnapshotDetail.test.tsx:236–247` and e2e `s5a-cases.spec.ts:618–623` move to the tab.
- Requirements: `req~frontend-snapshot-source-tab~1`, `req~frontend-snapshot-leave-allow-list~1`. About 180 lines.
  Turn budget 50.

### S7 `m25-render-close` (sequential, last; risk low)
- Owns: `frontend/src/test/rawRenderingHygiene.test.ts` (one closing assertion: no entry with `retiredBy: 'M2.5'`),
  `docs/qa/RENDERING_CATALOGUE.md` (offender table and counts), `ROADMAP.md` (M2 slice-status paragraph only, never
  the `Status:` lines), `openspec/changes/m25-render-close/**`.
- Depends on S1–S6 merged; rebases on M2.3's catalogue edits if they landed. About 40 lines. Turn budget 25.

## Order and parallelism

```
S0 ──► S1 ┐
   ├─► S2 ┤ (S2 after m24-retire-sponsorship if it needs s9a-admin.spec.ts)
   ├─► S3 ┤
   ├─► S4 ├──► S7
   ├─► S5 ┤ (S5 after M2.3's workbench slice only if it needs s5d-workbench.spec.ts)
   └─► S6 ┘
```

S1–S6 own disjoint globs and can run at the same time once S0 is in `develop`. S2 and S4 both sit near the engine
pages but do not overlap: S2 owns `EngineParts.*`, the registration detail and the language extensions; S4 owns the
`RegisterEngine` form, `engineDraft.ts` and `manifestModel.*`. `RegisterEngine.tsx` is edited by neither, and its
test asserts nothing about the source view.

## Dependencies on M2.3 (no M2.3 change exists yet: nothing under `openspec/changes/m23-*`)

- Ledger: M2.3 retires offenders 1–4 in the same two files. If S0 lands first, M2.3 deletes `offender-01..04.ts`
  instead of editing the list. If an M2.3 PR is already open when S0 is ready, S0 waits for it and rebases.
- `frontend/e2e/s5d-workbench.spec.ts`: M2.3 territory; S5 stays out of it (see S5).
- `frontend/src/components/rendering/**`: M2.3 owns it. M2.5 imports `SourceView` and `MetricCards` read-only and does
  not use `VerdictBadge` for `INFEASIBLE`/`UNKNOWN` until M2.3 maps them (the cell outcome stays as figures).
- `docs/qa/RENDERING_CATALOGUE.md`: M2.3 documents its components there; S7 runs after or rebases.
- No functional dependency: no M2.5 slice needs an M2.3 component.

## Checks per slice (argument arrays for the contracts)

`<paths>` are the slice's test files or folders; `<id>` is its change id.

- Red before (test-designer, gate G3): `{"argv": ["bash", "-c", "set -euo pipefail; cd frontend; pnpm install
  --frozen-lockfile; pnpm exec vitest run <paths>"], "type": "red_before", "expect_exit": [1], "expect_pattern":
  "AssertionError|Unable to find|expected", "overlay": [<the new or changed test files>]}`
- Targeted unit: `["bash", "-c", "set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run <paths> src/test"]`
- Full unit (G5): `["bash", "-c", "set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run"]` (timeout 900)
- Lint: `["bash", "-c", "set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec eslint ."]`
- Types: `["bash", "-c", "set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec tsc -b"]`
- Spec (G1): `["openspec", "validate", "<id>", "--strict"]` once the lab has the CLI; until then CI runs `openspec validate --strict --all`.
- Playwright: the touched spec (`s7a`, `s8a`/`s9a`, `s4a`, `s5a`) is not run by workers (as in M2.4); CI is the first
  run, and the lead reads it with `ci_status`.

## Risks

- S0 contradicts the exact-value scenarios of the unarchived `m21-rendering-catalogue` and `m24-retire-*` changes
  (`MAX_ALLOWED_OFFENDERS` 12, exact lists). Mitigation: S0's design names them, and the archive task reconciles them.
- S2 touches a helper with six consumers. Mitigation: keep the export, its props and its summary text; run the full
  unit suite; medium panel.
- Source tabs change e2e selectors (s7a, s8a, s5a). Mitigation: each slice owns its spec; CI verifies.
- ui-qa screenshots (G12) catch rendering that the line-based detector misses.

## Open questions

1. The request body could not be read (file missing). Waiting on the coordinator: confirm it adds nothing beyond
   ROADMAP M2.5 and the brief.
2. Constitution 15.2 says "tab or download", while 15.4 allows disclosure for details. Waiting on the owner or
   coordinator: confirm decision 2, that a collapsed, labelled disclosure holding `SourceView` is acceptable inside
   cards, panels, rows and wizard steps.
3. S0 vs the serial-ledger fallback (decision 1). Coordinator decision; the recommendation is S0.
4. ARCHITECTURE §5.3 says `SourceView` is used "only in Source tabs". The coordinator owns that file; the wording
   should match the answer to question 2.

## Outside M2.5 (followups)

- Admin sources (`AdminAudit`, `AdminErrors`, `AdminEngineReview`) as tabs if question 2 says disclosures are not enough.
- Digests and UUIDs on these screens: snapshot fingerprints, the cell fingerprint, audit event and target ids. These
  belong to M2.7.
- Unlisted finding 16 (`pages/Workbench/SourcePanel.tsx`, diff `<pre>`) is still unclassified.
- An archive task for the M2.5 changes, reconciling them with m21 and m24.
