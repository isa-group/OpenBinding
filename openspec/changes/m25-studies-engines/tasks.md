# Tasks: m25-studies-engines

ROADMAP M2.5 in three page groups and one closing task (intake slices S1–S6). Tests carry
`[utest->req~<name>~1]` and code carries `[impl->…]` (design.md §7). Each group is test-first: a test-designer task
writes the failing tests and proves them red (G3), then an implementer task, then the review panel by risk. Groups A, B
and C own disjoint files and may run in parallel. Group D runs last, after change `m23-run-result` merges into
`develop` (design.md §8).

Checks the groups register. Each is a `bash -c 'set -euo pipefail; cd frontend; …'` argv, in the forms of
intake.md "Checks per slice":
- FI: `pnpm install --frozen-lockfile`, first.
- RED (G3), `red_before`: FI, then `pnpm exec vitest run <the group's test files>`, overlaying only those files;
  `expect_exit [1]`, `expect_pattern` `AssertionError|TestingLibraryElementError|Unable to find`, `reject_pattern`
  `Failed to resolve import|Cannot find module|Transform failed|SyntaxError`.
- V: `pnpm exec vitest run <the group's test files>`. Not `src/test`: the hygiene test reports the group's stale
  entries until D (design.md §8).
- LINT: `pnpm exec eslint .`. TSC: `pnpm exec tsc -b`.
- VALL (G5), timeout 900: `pnpm exec vitest run`, in group D only.
- Playwright: the touched specs are not run by workers; CI is the first run, read with `ci_status`.
- G1: `["openspec", "validate", "m25-studies-engines", "--strict"]`.

## 0. Spec
- [x] 0.1 proposal.md, design.md, this file and the `frontend-rendering` delta with eight ADDED requirements.
- [x] 0.2 G1 (`openspec validate m25-studies-engines --strict`): valid.
- [ ] 0.3 G2 (epic review).

## A. Studies and audit (risk low; offenders 8, 9, 12)
Owns: `frontend/src/pages/Studies/{StudyDetail.tsx,StudyCell.tsx,Studies.css,parts.tsx,StudyDetail.test.tsx,StudyCell.test.tsx}`,
`frontend/src/pages/Organization/{OrgAudit.tsx,auditModel.ts,auditModel.test.ts,OrgAudit.test.tsx,Organization.css}`
(audit rules only), `frontend/e2e/s7a-studies.spec.ts`, `frontend/e2e/s4a-org.spec.ts`.

Tests first:
- [ ] A.1 `StudyDetail.test.tsx`: tab list `Study views`, `Overview` selected, `Source` with the region
  `Study definition source` and the download `<slug>-definition.json`, no `View source` disclosure, every `<pre>`
  inside a `SourceView` region. The test at :73 moves to the tab.
- [ ] A.2 `StudyCell.test.tsx`: tab list `Cell views`, `Result` selected, the region `Cell metrics source` with the six
  keys in order, the download `cell-<ordinal>.json`, a queued cell, actions in both tabs. The test at :259 moves to
  the tab.
- [ ] A.3 `auditModel.test.ts` (new): `detailRows` for scalars, readable keys, arrays, nested objects, `null`/empty as
  `none`. `OrgAudit.test.tsx`: the rendered rows, no `{ } [ ] "` in the card text, CSV `detail` column unchanged.
- [ ] A.4 RED (G3) on A.1–A.3.

Source:
- [ ] A.5 `StudyDetail.tsx`, `StudyCell.tsx`: `TabBar` + `TabPanel`, `SourceView` in `Source`; drop the `st-source`
  disclosure and its CSS (design.md §3).
- [ ] A.6 `auditModel.ts`: `detailRows`; `OrgAudit.tsx`: render the rows, no stringify (design.md §4).
- [ ] A.7 e2e `s7a-studies.spec.ts` (:606, :827) to the `Source` tab; `s4a-org.spec.ts` (:858) to the rows if it
  reads them.
- [ ] A.8 FI, V, LINT, TSC. Review: reviewer and test-reviewer; ui-qa (1440×900 and 390×844).

## B. Engines and registration (risk medium: six `ViewSource` consumers; offenders 10, 13)
Owns: `frontend/src/pages/Engines/{EngineParts.tsx,EngineParts.css,EngineParts.test.tsx,EngRegistrationDetail.tsx,EngRegistrationDetail.test.tsx,LangExtensions.tsx,LangExtensions.test.tsx,manifestModel.ts,manifestModel.test.ts}`,
`frontend/src/pages/RegisterEngine/{EngineForm.tsx,RegisterEngine.css,RegisterEngine.test.tsx}`,
`frontend/src/pages/Admin/{AdminAudit,AdminErrors,AdminEngineReview}.test.tsx` (only if an assertion breaks),
`frontend/e2e/s8a-engines.spec.ts`. Not `frontend/e2e/s9a-admin.spec.ts`: if it needs a change, B waits for
`m24-retire-sponsorship` to merge and then takes it.

Tests first:
- [ ] B.1 `EngineParts.test.tsx` (new): `ViewSource` collapsed with its summary, opened as the region
  `<label> (JSON)` with Copy and no Download, custom label, string/number/boolean/`null`/`undefined` values.
- [ ] B.2 `EngRegistrationDetail.test.tsx`: tab list `Engine manifest views`, `Manifest` selected, `Source` with the
  region `Engine manifest source` and the download `<name>-<version>-engine.json`; unreadable and missing manifest.
  The test at :134 moves to the tab.
- [ ] B.3 `LangExtensions.test.tsx`: the row's closed `View source` disclosure holds the `SourceView` region; no tab
  list in the row.
- [ ] B.4 `manifestModel.test.ts`: `fixedValueText` for `const`, `enum`, numbers, neither. `RegisterEngine.test.tsx`:
  `always tabu`, `one of a, b`, the list `Schema of <name>`, `nested schema`, no `{ } "` in the option rows.
- [ ] B.5 RED (G3) on B.1–B.4.

Source:
- [ ] B.6 `EngineParts.tsx`: `ViewSource` renders `SourceView` (design.md §2); `ManifestPanel` drops its trailing
  `ViewSource`; the `eng-source` CSS keeps only the disclosure rules.
- [ ] B.7 `EngRegistrationDetail.tsx`: the `Manifest`/`Source` tab pair (design.md §3).
- [ ] B.8 `manifestModel.ts`: export `fixedValueText`, used by `readOptions`; `EngineForm.tsx`: the fixed option row
  (design.md §5).
- [ ] B.9 e2e `s8a-engines.spec.ts` (:278, :567, :685) to the tab or the region.
- [ ] B.10 FI, V (with the three admin tests and `RegisterEngine.test.tsx`), LINT, TSC. Review: medium panel; ui-qa.

## C. Generator and snapshot (risk low; offenders 14, 15)
Owns: `frontend/src/pages/Generator/{LabAside.tsx,Generator.css,GeneratorLab.test.tsx}`,
`frontend/src/pages/Cases/{SnapshotDetail.tsx,SnapshotDetail.test.tsx}`, `frontend/src/pages/Platform/SnapshotPage.css`,
`frontend/e2e/s5a-cases.spec.ts`. Not `frontend/e2e/s5d-workbench.spec.ts` (design.md §6).

Tests first:
- [ ] C.1 `GeneratorLab.test.tsx`: the `View source` disclosure and `File` combobox stay; the region named by the
  file, Copy and Download under its name, a file in a folder, collapsed until asked. The test at :150 keeps its
  steps.
- [ ] C.2 `SnapshotDetail.test.tsx`: tab list `Snapshot views`, `Overview` selected, `Source` with the `Source to view`
  group, the region `Compiled form (JSON)` with the download `snapshot-<id>-compiled.json`, no compiled form, a package
  file as `Preview of <name>`, no code editor, the archive requested only after `Files in the package`. The tests at
  :236–247 move to the tab.
- [ ] C.3 RED (G3) on C.1–C.2.

Source:
- [ ] C.4 `LabAside.tsx`: `SourceView` for the chosen file (design.md §6).
- [ ] C.5 `SnapshotDetail.tsx`: `Overview`/`Source` tabs; `SourceView` for both views; archive condition kept; the
  `snap-source` disclosure and its CSS go (design.md §3).
- [ ] C.6 e2e `s5a-cases.spec.ts` (:618–623) to the `Source` tab.
- [ ] C.7 FI, V, LINT, TSC. Review: reviewer and test-reviewer; ui-qa.

## D. Closing task: leave the allow-list (after `m23-run-result` merges)
Delivers `req~frontend-m25-leave-allow-list~1`. It starts only when change `m23-run-result` (H1 → J1 → W1) has
merged into `develop` and the branch is rebased on it. Until then these files belong to that change.
Owns: `frontend/src/test/rawRenderingAllowList.ts`, `frontend/src/test/rawRenderingHygiene.test.ts`,
`docs/qa/RENDERING_CATALOGUE.md` (offender table and counts).

- [x] D.1 Test first: in `rawRenderingHygiene.test.ts`, the assertion that no entry is numbered 8, 9, 10, 12, 13,
  14 or 15 and none has `retiredBy` `M2.5`; the seven files have no detector finding; the exact-list and ceiling
  assertions at their new values. RED (G3) against the list as `m23-run-result` left it.
- [x] D.2 `rawRenderingAllowList.ts`: delete the seven entries; `MAX_ALLOWED_OFFENDERS` minus seven; the
  `[impl->req~frontend-m25-leave-allow-list~1]` tag.
- [x] D.3 `docs/qa/RENDERING_CATALOGUE.md`: offender table and counts.
- [ ] D.4 FI, VALL (G5), LINT, TSC, G1; CI for the Playwright specs of A–C.
- [ ] D.5 Open the PR into `develop` (one PR for A–D unless the coordinator splits it, design.md §9). The
  `ROADMAP.md` M2 status paragraph is placed by the coordinator.
- Acceptance: every scenario of the eight requirements has a test; VALL, LINT and TSC pass; CI green.

## Archive (later)
- [ ] After `m21-rendering-catalogue` and the M2.3 changes are archived, archive this change in an explicit archive
  task: `["openspec", "archive", "m25-studies-engines", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.
  Reconcile the exact-list and ceiling scenarios of `m21-rendering-catalogue` and `m24-retire-*` that D changes.

## Follow-ups outside this change
- Owner: confirm the tab-or-disclosure reading of 15.2 (design.md §1, §10); the coordinator then aligns ARCHITECTURE
  §5.3. If disclosures are not accepted, the admin asides need tabs (a change of their own).
- M2.7: digests and UUIDs on these screens (snapshot and cell fingerprints, audit event and target ids).
- Unlisted finding 16 (`pages/Workbench/SourcePanel.tsx`, diff `<pre>`): still to be classified.
