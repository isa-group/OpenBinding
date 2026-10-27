# Design: m25-studies-engines

Status: specified; nothing built. Fixed inputs: ROADMAP M2.5, constitution Article 15, ADR-0014,
`docs/agent-work/m25-render-rest/intake.md` (slices S1–S6, decisions 2–4), the `SourceView` contract of
`m21-rendering-catalogue` (`req~frontend-rendering-source-view~1`), and `components/ui/TabBar` + `TabPanel`.

## 1. Source tab or labelled disclosure

| Where the source lives | How it is shown | Screens |
|---|---|---|
| The item's own page | a real `Source` tab (`TabBar` + `TabPanel`), read-only, holding `SourceView`, beside an `Overview`/`Result`/`Manifest` tab that is selected by default | study, study cell, snapshot, engine registration detail |
| A card, side panel, list row or wizard step | a collapsed, labelled disclosure (`<details>` with a named summary) holding `SourceView` | generator preview, register review step, language-extension rows, admin asides |

Reason: constitution 15.2 allows a source only as a secondary, labelled tab or a download. 15.4 puts details
"behind tabs or disclosure". A tab bar inside a card or a row would put a second navigation level on a screen
whose primary question is elsewhere. The disclosure is closed by default, labelled, and holds the same catalogue
viewer. This reading of 15.2 is the intake's open question 2. It is recorded here as the rule, and the owner has
still to confirm it (see §10).

Tabs are local state (`useState`), not part of the address. The first tab is selected on every visit. Considered: a
`?view=source` parameter. Rejected: no link or test needs to open a source directly, and the address of each page
stays as it is. Each page gives its `TabBar` its own `prefix` and an `ariaLabel` (`Study views`, `Cell views`,
`Engine manifest views`, `Snapshot views`). Only the active tab's content is rendered. The page header, its actions
and its notices stay above the tab bar, so they show in both tabs.

## 2. No new shared component, no flag, no API change

- Nothing is added under `frontend/src/components/**`. M2.3 owns `components/rendering/**` while it builds
  `BindingTable` and the run views. `SourceView` and `TabBar` are imported as they are, unchanged.
- No feature flag. Each group leaves its screens complete and consistent, and no behaviour spans groups.
- No HTTP API, OpenAPI document, gateway, worker or database change. Every source shown is data the page already
  loads; the snapshot archive keeps its existing request.

`ViewSource` (`pages/Engines/EngineParts.tsx`) keeps `export function ViewSource({ value, label = 'View source' })`.
Its `<details className="eng-source">` and `<summary>{label}</summary>` stay; the `<pre>` and the `useMemo`
stringify go. Inside the disclosure it renders `<SourceView source={…} label={`${label} (JSON)`} />`, without
`filename`, so its props do not grow. The name `<label> (JSON)` keeps the accessible name that tests and e2e query
today (`View source (JSON)`). How `value: unknown` is passed on:

| `value` | `source` given to `SourceView` |
|---|---|
| a non-null object or an array | the value itself (`SourceView` indents it) |
| a string | the string as is |
| a number or a boolean | `String(value)` |
| `null` or `undefined` | `''` (shown as `Empty`) |

Its six consumers today:

| Consumer | After this change |
|---|---|
| `ManifestPanel` on `EngRegistrationDetail` | the manifest source moves to the `Source` tab of §3, so `ManifestPanel` no longer renders `ViewSource` |
| `LangExtensions` rows | `ViewSource`, unchanged call |
| `RegisterEngine` review step | `ViewSource`, unchanged call |
| `AdminAudit` aside | `ViewSource`, unchanged call, source not edited |
| `AdminErrors` aside | `ViewSource`, unchanged call, source not edited |
| `AdminEngineReview` (three reports) | `ViewSource`, unchanged calls, source not edited |

Admin and register tests change only if an assertion breaks. The e2e `s9a-admin.spec.ts` reads the readable field,
not the source, so it is expected to stay as it is.

## 3. Pages with a Source tab

| Page | Default tab | Source tab: `SourceView` | `filename` |
|---|---|---|---|
| `StudyDetail` | `Overview`: definition matrix, runs, versions | `source={study.definition}`, `label="Study definition source"` | `<study slug>-definition.json` |
| `StudyCell` | `Result`: frozen inputs, outcome figures, failure/cancel/active notices, rivals, linked job line | `source={{ state, job_id, engine: engine_ref, parameters, seed, metrics }}` (the same object and key order as today), `label="Cell metrics source"` | `cell-<ordinal>.json` |
| `EngRegistrationDetail`, section `Engine manifest` | `Manifest`: `ManifestPanel` without its trailing `ViewSource` | `source={detail.engine}`, `label="Engine manifest source"` | `<name>-<version>-engine.json` |
| `SnapshotDetail` | `Overview`: fingerprints, exact language, what the engines receive, downloads | see below | see below |

The snapshot's `Source` tab keeps the `Source to view` group of two `aria-pressed` buttons. `Compiled form (JSON)`
is selected first and disabled without a stored compiled form. Its view is
`<SourceView source={snapshot.ir.document} label="Compiled form (JSON)" filename={`snapshot-${id}-compiled.json`} />`:
an object, no stringify in the page, and the same file name as the `Compiled form` download card. `Files in the
package` keeps its file list and replaces the read-only `CodeEditor` with
`<SourceView source={text} label={`Preview of ${entry.name}`} filename={entry.name} />`. The archive request keeps
its condition: it runs only while the `Source` tab is active with `Files in the package` chosen. The old
`open` (disclosure toggle) becomes "the Source tab is active". The `snap-source` disclosure and its CSS go.

When the registration detail has no manifest, the section keeps its sentence and shows no tabs. When
`readManifest` cannot read it, the `Manifest` tab shows the existing sentence and the `Source` tab still holds the
document.

## 4. Audit detail rows

A pure `detailRows(detail)` in `pages/Organization/auditModel.ts` turns `event.detail` (without `changes`) into
typed rows, and `OrgAudit.tsx` renders them. It is recursive at every depth:

| Value | Row |
|---|---|
| string | as is |
| number | `toLocaleString('en-US')` |
| boolean | `yes` / `no` |
| `null`, `undefined`, `[]`, `{}` | `none` |
| array | `<ul>` of its items, each by these rules |
| object | nested `<dl>` of its entries, each by these rules |

Readable keys: `snake_case`, `camelCase` and `kebab-case` become words, and the first letter is upper-cased
(`old_role` → `Old role`, `billingSponsorUserId` → `Billing sponsor user id`). `changes` keeps its own list
(`marco → ADMIN`). `toCsv` is unchanged. Its `detail` column stays `JSON.stringify(event.detail ?? {})`: a download,
allowed by 15.2 and ADR-0014 ("exports remain available as downloads"), and not rendered.

## 5. Fixed registration option

`manifestModel.ts` exports one helper, `fixedValueText(schema)`, that returns `always <scalar>` for `const`,
`one of <a>, <b>` for `enum` and `null` otherwise, with the existing `scalar` formatting (en-US numbers). Its
`readOptions` uses it, so the manifest view and the form say the same thing. `EngineForm.tsx` shows, under `Fixed in
the manifest`, that text and a list `Schema of <name>` of the other keywords of `option.rest` as `keyword: value`,
where a scalar is formatted the same way, an array of scalars is joined with `, `, and an object, or an array that
holds one, reads `nested schema`. `engineDraft.ts` is unchanged: `rest` still round-trips the schema unchanged into
the manifest it builds.

## 6. Generator preview

`SourceOfFiles` in `LabAside.tsx` keeps `<details className="gl-details">`, `<summary>View source</summary>` and the
`File` label and select. The bare `<pre>` becomes
`<SourceView source={text[shown]} label={shown} filename={last segment of shown} />`. The selectors that
`frontend/e2e/s5d-workbench.spec.ts` (gen-lab test, lines 570–656) uses stay, so that spec is not edited. M2.3 owns
it for the workbench run views. If an e2e change turns out to be needed, group C waits for M2.3's workbench slice to
merge and then takes the spec.

## 7. Requirements, tests and tags

| Requirement | Tests | `[impl->…]` |
|---|---|---|
| `frontend-studies-source-tab` | `StudyDetail.test.tsx`, `StudyCell.test.tsx`, e2e `s7a-studies.spec.ts` | `StudyDetail.tsx`, `StudyCell.tsx` |
| `frontend-audit-detail-rendered` | `auditModel.test.ts` (new), `OrgAudit.test.tsx`, e2e `s4a-org.spec.ts` | `auditModel.ts`, `OrgAudit.tsx` |
| `frontend-engines-source-view` | `EngineParts.test.tsx` (new), `LangExtensions.test.tsx`, admin and register tests if their assertions break | `EngineParts.tsx` |
| `frontend-engines-manifest-source-tab` | `EngRegistrationDetail.test.tsx`, `LangExtensions.test.tsx`, e2e `s8a-engines.spec.ts` | `EngRegistrationDetail.tsx`, `EngineParts.tsx` |
| `frontend-registration-fixed-option-rendered` | `manifestModel.test.ts`, `RegisterEngine.test.tsx` | `manifestModel.ts`, `EngineForm.tsx` |
| `frontend-generator-files-source-view` | `GeneratorLab.test.tsx` | `LabAside.tsx` |
| `frontend-snapshot-source-tab` | `SnapshotDetail.test.tsx`, e2e `s5a-cases.spec.ts` | `SnapshotDetail.tsx` |
| `frontend-m25-leave-allow-list` | `test/rawRenderingHygiene.test.ts` | `test/rawRenderingAllowList.ts` |

Tests carry `[utest->req~<name>~1]`. "The detector reports no finding in a file" scenarios use the detector
functions as the hygiene test exports them at the time of group D (`findRawRendering` today).

## 8. Scope boundaries and the closing task

- `frontend/src/test/rawRenderingAllowList.ts`, `frontend/src/test/rawRenderingHygiene.test.ts` and
  `docs/qa/RENDERING_CATALOGUE.md` belong to change `m23-run-result` until it merges into `develop`. Its slices H1 →
  J1 → W1 each lower `MAX_ALLOWED_OFFENDERS` and rewrite the exact-list and ceiling assertions. Groups A–C do not
  touch these files.
- The intake's S0 (one entry file per offender) is not part of this change. `m23-run-result`'s handoff ruled the
  split out ("changes the M2.2 ratchet"), so this change uses the single list as it stands after `m23-run-result`.
- Consequence: the hygiene test fails on a stale entry ("no longer raw rendering: remove this entry"). Once a group
  removes its raw line, `staleEntries` reports it until group D deletes the entry. Groups A–C therefore prove
  themselves with their targeted page tests. The full unit suite (G5) and the PR into `develop` come after group D.
- Group D (closing task), after `m23-run-result` merges and the branch is rebased on `develop`: delete the entries
  8, 9, 10, 12, 13, 14 and 15, lower `MAX_ALLOWED_OFFENDERS` by seven from the value it then has, update the
  exact-list and ceiling assertions, add the assertion of `req~frontend-m25-leave-allow-list~1`, and update the
  offender table and counts of `docs/qa/RENDERING_CATALOGUE.md`. The `ROADMAP.md` M2 slice-status paragraph is the
  coordinator's to place (intake S7). It is not in this change's file list.

## 9. Risks

- `ViewSource` has six consumers. Mitigation: export, props and summary unchanged; the region keeps the name
  `<label> (JSON)`; full unit suite after D; medium review panel for group B.
- One visible difference: a string `value` used to be shown JSON-quoted (`"kind: Engine"`) and now shows as is.
  A consumer that passes a string (an OpenAPI document as YAML text, say) now shows it as written, which is the
  intent; group B's tests pin it.
- Tabs change e2e selectors in `s7a`, `s8a`, `s5a` and `s4a`. Each group owns its specs; workers do not run
  Playwright, so CI is the first run (`ci_status`).
- Size: about 330 (A), 370 (B) and 280 (C) diff lines with tests, plus about 40 for D, above the ~300-line guideline
  (constitution 14.1) when delivered as one PR. Reason: the single allow-list (§8) makes every group's PR depend
  on D. The coordinator may instead deliver A, B and C as three PRs. Each would then carry its own share of D, one
  after another in merge order, after `m23-run-result` merges.
- The line-based detector misses raw rendering built without `<pre` or `JSON.stringify(`. The DOM scenarios ("every
  `<pre>` is inside a `SourceView` region") and ui-qa screenshots (G12) cover it.

## 10. Open questions

1. Owner: confirm the reading of 15.2 in §1, that a collapsed, labelled disclosure holding `SourceView` is
   acceptable inside cards, panels, rows and wizard steps (intake open question 2). ARCHITECTURE §5.3 ("only in Source
   tabs") is the coordinator's to align with the answer.
2. Coordinator: one PR after D, or three PRs that each retire their own entries serially (§9).

## 11. Rollback

Reverting the PR restores the disclosures, the stringified values and the seven allow-list entries. No data, API or
stored state is touched.
