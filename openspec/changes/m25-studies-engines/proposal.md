# Change: m25-studies-engines

## Why

ROADMAP M2.5: "Studies, engines, audit, registration and generator rendered; raw views moved to Source tabs",
accepted when "offenders 8–10 and 12–15 removed". Constitution Article 15 (15.1 nothing raw as main content; 15.2 a
source only as a secondary, labelled tab or an explicit download, through the catalogue's read-only viewer; 15.4
details behind tabs or disclosure) and ADR-0014 (render, never dump). The plan is
`docs/agent-work/m25-render-rest/intake.md`, slices S1–S6, with its cross-cutting decisions 2 (tab or disclosure),
3 (no new shared component) and 4 (no feature flag). This change brings those six slices together in one change of
the `frontend-rendering` capability, in three page groups.

All seven screens already render their main content. What is left is five source views (offenders 8, 9, 10, 14, 15)
and two stringified values (12, 13):

| # | File (under `frontend/src`) | What is raw today |
|---|---|---|
| 8 | `pages/Studies/StudyCell.tsx` | `<pre>` of the cell state, job, engine, parameters, seed and metrics inside `<details>View source` |
| 9 | `pages/Studies/StudyDetail.tsx` | `<pre>` of the study definition inside `<details>View source` |
| 10 | `pages/Engines/EngineParts.tsx` | `ViewSource`: `<pre>` of `JSON.stringify(value)`, used by six screens |
| 12 | `pages/Organization/OrgAudit.tsx` | audit detail values: `JSON.stringify(value)` for anything that is not a string |
| 13 | `pages/RegisterEngine/EngineForm.tsx` | fixed option: `<code>{JSON.stringify(option.rest)}</code>` |
| 14 | `pages/Generator/LabAside.tsx` | the chosen generated file in a bare `<pre>` inside `<details>View source` |
| 15 | `pages/Cases/SnapshotDetail.tsx` | `CodeEditor value={JSON.stringify(snapshot.ir.document)}` inside `<details>View source` |

## What Changes

- Study and study cell pages: an `Overview` (study) or `Result` (cell) tab, selected by default, and a `Source` tab
  that holds `SourceView` with a download filename. The `View source` disclosure goes.
- Engines: `ViewSource` keeps its export, props and `View source` summary but renders `SourceView`, so its six
  consumers (registration, language extensions, register review step, three admin screens) use the catalogue viewer.
  The engine registration detail shows its manifest in a `Manifest`/`Source` tab pair. Language-extension rows keep a
  labelled, collapsed disclosure.
- Organization audit: detail values become typed rows (strings as they are, numbers and booleans formatted, arrays
  as lists, objects as nested definition lists with readable keys, `null` as `none`). The CSV export keeps its JSON
  column.
- Engine registration form: a fixed option reads like the manifest view (`always tabu`, `one of a, b`), with any
  other schema keywords as a short keyword and value list.
- Generator preview: the `View source` disclosure and the `File` combobox stay; the chosen file shows in
  `SourceView`, with Copy and Download under its own name.
- Snapshot page: `Overview` (default) and `Source` tabs. The `Source` tab keeps the choice between the compiled form
  and the package files, both in `SourceView`. The package archive loads only when the files view opens. The closing
  task then removes offenders 8, 9, 10, 12, 13, 14 and 15 from the allow-list.

## Impact

- Capability: `frontend-rendering`. Eight ADDED requirements, all `~1`: `frontend-studies-source-tab`,
  `frontend-engines-source-view`, `frontend-engines-manifest-source-tab`, `frontend-audit-detail-rendered`,
  `frontend-registration-fixed-option-rendered`, `frontend-generator-files-source-view`,
  `frontend-snapshot-source-tab` and `frontend-m25-leave-allow-list`.
- Code: frontend only, in the pages and tests of tasks.md (groups A, B, C) and, in the closing group D, the
  allow-list and hygiene test files and `docs/qa/RENDERING_CATALOGUE.md`. Nothing new under
  `frontend/src/components/**`: the pages use `SourceView` (M2.1) and `components/ui/TabBar` + `TabPanel` as they are.
- No HTTP API, OpenAPI, gateway, worker, engine or database change. No `package.json` or lockfile change; no new
  dependency. No feature flag.
- Playwright: `s7a-studies`, `s8a-engines`, `s5a-cases` and `s4a-org` change their selectors to the new tabs.
  `s9a-admin` and `s5d-workbench` stay unchanged (design.md §2, §6).
- Order: groups A–C can be built in parallel. Group D waits for change `m23-run-result` to merge into `develop`,
  because that change owns the allow-list, the hygiene test and the catalogue page until then. The full unit suite
  is green only after D, so the PR into `develop` opens after D (design.md §8).
- Risks: `ViewSource` has six consumers; the tabs change e2e selectors; the change is above the ~300-line guideline
  (constitution 14.1, design.md §9).

## Out of scope

- The admin screens' own layout (`AdminAudit`, `AdminErrors`, `AdminEngineReview`): they keep `ViewSource` in their
  asides and their sources are not edited.
- Digests and UUIDs shown on these screens (snapshot fingerprints, cell fingerprint, audit event and target ids):
  M2.7.
- Offenders 1–7 and 11 (M2.3, M2.4, M2.6) and unlisted finding 16 (`pages/Workbench/SourcePanel.tsx`).
- Any new component under `frontend/src/components/rendering/**` (owned by M2.3), and any change to `SourceView`.
- Editing ARCHITECTURE §5.3, ADR-0014 or constitution Article 15.
- Archiving this change into `openspec/specs/frontend-rendering/` (separate, explicit archive task).
