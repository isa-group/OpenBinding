## ADDED Requirements

### Requirement: Study and cell sources in a Source tab
THE study page and the study cell page SHALL show the item's source only in a `Source` tab that holds `SourceView` with a download filename, beside an `Overview` tab (study) or a `Result` tab (cell) that is selected by default.

`req~frontend-studies-source-tab~1`

Needs: impl, utest

Placement rule: design.md §1; content and tests: §3, §7; file names as built: §12.

#### Scenario: The study opens on its overview
- **GIVEN** the study `engines-vs-seeds` with a definition
- **WHEN** its page `/app/<org>/<project>/studies/engines-vs-seeds` opens
- **THEN** a tab list named `Study views` holds the tabs `Overview` and `Source`, in that order, with `Overview` selected
- **AND** the definition matrix and the runs card are in the tab panel
- **AND** there is no region named `Study definition source`

#### Scenario: The study definition in the Source tab
- **GIVEN** the study page of `engines-vs-seeds`
- **WHEN** the tab `Source` is pressed
- **THEN** `Source` is selected and a region named `Study definition source` shows `study.definition` as indented JSON
- **AND** the button `Download Study definition source` saves it as `engines-vs-seeds.definition.json` with type `application/json`
- **AND** the definition matrix is no longer in the document

#### Scenario: The cell opens on its result
- **GIVEN** the completed cell 2 of a run
- **WHEN** its page opens
- **THEN** a tab list named `Cell views` holds the tabs `Result` and `Source`, in that order, with `Result` selected
- **AND** the region `Frozen inputs` and the region `Result` are in the tab panel
- **AND** there is no region named `Cell metrics source`

#### Scenario: The cell source in the Source tab
- **GIVEN** the page of cell 2
- **WHEN** the tab `Source` is pressed
- **THEN** a region named `Cell metrics source` shows an object whose keys are `state`, `job_id`, `engine`, `parameters`, `seed` and `metrics`, in that order, with the cell's values
- **AND** the button `Download Cell metrics source` saves it as `<cell id>.cell.json` with type `application/json`

#### Scenario: A cell that has not finished
- **GIVEN** a queued cell 3 with no metrics
- **WHEN** its page opens and the tab `Source` is pressed
- **THEN** the region `Cell metrics source` shows `"state": "queued"`
- **AND** the header action `Retry this cell` or `Use an existing job’s result`, when the viewer may use it, is present in both tabs

#### Scenario: Nothing raw is left on the two pages
- **GIVEN** the study page and the cell page, each with its `Source` tab open
- **WHEN** the document is read
- **THEN** there is no `<details>` element whose summary reads `View source`
- **AND** every `<pre>` element is inside a `SourceView` region

### Requirement: The engines' ViewSource renders the catalogue viewer
THE `ViewSource` helper of `frontend/src/pages/Engines/EngineParts.tsx` SHALL show its value only through the catalogue `SourceView`, inside a collapsed disclosure whose summary is its `label` (default `View source`), in a region named by `sourceLabel`, else `Source document` for the default label, else the label, and SHALL offer Download only when given a `filename`.

`req~frontend-engines-source-view~1`

Needs: impl, utest

Consumers and value mapping: design.md §2 as amended by §12; tests: §7.

#### Scenario: Collapsed with its summary
- **GIVEN** `<ViewSource value={{ kind: 'Engine' }} />`
- **WHEN** it is rendered
- **THEN** a closed `<details>` element has the summary `View source`
- **AND** the region named `Source document` is not visible

#### Scenario: Opened, it is the catalogue viewer
- **GIVEN** `<ViewSource value={{ kind: 'Engine' }} />`
- **WHEN** its summary is pressed
- **THEN** the region named `Source document` is visible and its `<code>` text equals `JSON.stringify({ kind: 'Engine' }, null, 2)`
- **AND** the region has a button named `Copy Source document` and no button named `Download Source document`

#### Scenario: A named source
- **GIVEN** `<ViewSource value={{ openapi: '3.1.0' }} label="Submitted OpenAPI" />`
- **WHEN** it is rendered and opened
- **THEN** the summary reads `Submitted OpenAPI` and the region is named `Submitted OpenAPI`
- **AND** with `sourceLabel="Engine manifest source"` the summary stays as given and the region is named `Engine manifest source`

#### Scenario: A download only with a filename
- **GIVEN** `<ViewSource value={{ kind: 'Engine' }} filename="engine.json" />`, opened
- **WHEN** the button `Download Source document` is pressed
- **THEN** the indented JSON is saved as `engine.json` with type `application/json`
- **AND** a string value is saved as written with type `text/plain`

#### Scenario: Values that are not objects
- **GIVEN** `ViewSource` with the values `'kind: Engine'`, `3`, `true`, `null` and `undefined`, one at a time
- **WHEN** each is rendered and opened
- **THEN** the region shows `kind: Engine`, `3`, `true` and `null` as text, and `Empty` for `undefined`

#### Scenario: Every consumer shows the catalogue viewer
- **GIVEN** the register-engine review step, an expanded row of the language extensions, the selected event of `AdminAudit`, the selected error of `AdminErrors` and an open report of `AdminEngineReview`
- **WHEN** their `ViewSource` disclosure is opened
- **THEN** each holds a region with a `Copy <region name>` button, named `Engine manifest source`, `<dialect> dialect source` and `Source document` (twice), and `Verification report`, `Submitted Engine` and `Submitted OpenAPI` for the three of `AdminEngineReview`
- **AND** none of these screens shows a `<pre>` outside a `SourceView` region

#### Scenario: Nothing raw in the helper
- **GIVEN** the text of `frontend/src/pages/Engines/EngineParts.tsx`
- **WHEN** the raw-rendering detector reads it
- **THEN** it reports no finding
- **AND** the file contains neither `<pre` nor `JSON.stringify(`

### Requirement: Engine manifest source in a tab or a labelled disclosure
THE engine screens SHALL place an engine or language-extension document by the rule of design.md §1: on the engine registration detail, in a `Source` tab beside a `Manifest` tab that is selected by default; in a language-extension row, in a labelled, collapsed disclosure that holds `SourceView`.

`req~frontend-engines-manifest-source-tab~1`

Needs: impl, utest

#### Scenario: The manifest opens laid out
- **GIVEN** the registration `edge-solver` whose detail carries an engine manifest with the mode `tabu`
- **WHEN** its registration page opens
- **THEN** in the region `Engine manifest`, a tab list named `Engine manifest views` holds the tabs `Manifest` and `Source`, in that order, with `Manifest` selected
- **AND** the region `Mode tabu` is in the tab panel
- **AND** there is no region named `Engine manifest source` and no summary `View source` in the region `Engine manifest`

#### Scenario: The manifest document in the Source tab
- **GIVEN** the registration page of `edge-solver` version `0.3.0`
- **WHEN** the tab `Source` is pressed
- **THEN** a region named `Engine manifest source` contains `"kind": "Engine"`
- **AND** the button `Download Engine manifest source` saves it as `engine.json`
- **AND** the region `Mode tabu` is no longer in the document

#### Scenario: A manifest that cannot be read
- **GIVEN** a registration whose manifest is not a readable `bim/v1` Engine
- **WHEN** its page opens
- **THEN** the `Manifest` tab shows `The engine manifest couldn’t be read as a bim/v1 Engine. Its document is on the Source tab.`
- **AND** after pressing `Source`, the region `Engine manifest source` shows the document as returned

#### Scenario: No manifest returned
- **GIVEN** a registration whose detail has no engine manifest
- **WHEN** its page opens
- **THEN** the region `Engine manifest` shows `The gateway didn’t return the engine manifest for this registration.` and holds no tab list

#### Scenario: A language-extension row keeps a labelled disclosure
- **GIVEN** the language extensions page with the expanded row `edge-annotations`
- **WHEN** the row is read
- **THEN** it holds a closed disclosure whose summary is `View source`, and its region `edge-annotations dialect source` is not visible
- **AND** after the summary is pressed, that region shows the row's document through `SourceView`, with `Download edge-annotations dialect source` saving `edge-annotations.dialect.json`
- **AND** the row holds no tab list

### Requirement: Audit event details rendered as typed rows
WHEN an event card of the organization audit page is open, the page SHALL render each detail value other than `changes` as a typed row (a string as it is, a number in en-US format, a boolean as `Yes` or `No`, an array as a list, an object as a nested definition list with readable keys, `null` and empty values as `none`), never as stringified JSON.

`req~frontend-audit-detail-rendered~1`

Needs: impl, utest

Rules at every depth: design.md §4 as amended by §12.

#### Scenario: Scalars
- **GIVEN** an open event whose detail is `{ role: 'ADMIN', seats: 1234.5, invited: true, reminded: false }`
- **WHEN** its card is read
- **THEN** it has the rows `Role` / `ADMIN`, `Seats` / `1,234.5`, `Invited` / `Yes` and `Reminded` / `No`, each a `<dt>` and a `<dd>`

#### Scenario: Readable keys
- **GIVEN** an open event whose detail is `{ old_role: 'MEMBER', billingSponsorUserId: 'nora', 'project-slug': 'qos' }`
- **WHEN** its card is read
- **THEN** the `<dt>` texts read `Old role`, `Billing sponsor user id` and `Project slug`

#### Scenario: An array as a list
- **GIVEN** an open event whose detail is `{ projects: ['qos-benchmarks', 'edge'] }`
- **WHEN** its card is read
- **THEN** the row `Projects` holds a list with the items `qos-benchmarks` and `edge`, in that order

#### Scenario: An object as a nested definition list
- **GIVEN** an open event whose detail is `{ quota: { limit_id: 'members', limit: 15, used: 16 } }`
- **WHEN** its card is read
- **THEN** the row `Quota` holds a nested `<dl>` with the rows `Limit id` / `members`, `Limit` / `15` and `Used` / `16`

#### Scenario: Missing and empty values
- **GIVEN** an open event whose detail is `{ reason: null, tags: [], extra: {} }`
- **WHEN** its card is read
- **THEN** the rows `Reason`, `Tags` and `Extra` each read `none`

#### Scenario: Never stringified
- **GIVEN** an open event whose detail is `{ quota: { limit: 5 }, ids: [1, 2] }`
- **WHEN** the card text is read
- **THEN** it contains none of `{`, `}`, `[`, `]` and `"`, which `OrgAudit.test.tsx` checks as one pattern over the whole opened card
- **AND** the raw-rendering detector reports no finding in `frontend/src/pages/Organization/OrgAudit.tsx`

#### Scenario: The CSV export keeps its JSON column
- **GIVEN** the audit page of `isa-demo` showing an event whose detail is `{ quota: { limit: 5 } }`
- **WHEN** the CSV export is pressed
- **THEN** the file `isa-demo-audit.csv` has the header `id,createdAt,actorId,action,targetType,targetId,detail`
- **AND** the `detail` cell of that event is the JSON text `{"quota":{"limit":5}}`, CSV-quoted

### Requirement: A fixed registration option reads like the manifest view
WHEN the engine registration form shows an option fixed in the manifest, the form SHALL describe it as the manifest view does (`always <value>` for `const`, `one of <a>, <b>` for `enum`) and list its other schema keywords as keyword and value pairs, never as stringified JSON.

`req~frontend-registration-fixed-option-rendered~1`

Needs: impl, utest

Shared wording helper `describeFixedOption`: design.md §5 as amended by §12.

#### Scenario: A constant
- **GIVEN** a manifest whose mode option `strategy` is `{ const: 'tabu' }`
- **WHEN** the registration form shows that option
- **THEN** the option row reads `Fixed in the manifest` and `always tabu`

#### Scenario: A list of values
- **GIVEN** a mode option `variant` that is `{ enum: ['a', 'b'] }`
- **WHEN** the registration form shows it
- **THEN** the option row reads `one of a, b`

#### Scenario: Numbers as in the manifest view
- **GIVEN** a mode option `budget` that is `{ const: 3600000 }`
- **WHEN** the registration form shows it
- **THEN** the option row reads `always 3,600,000`
- **AND** the manifest view of the same option reads `always 3,600,000` too

#### Scenario: Other schema keywords
- **GIVEN** a mode option `weights` that is `{ type: 'array', minItems: 1, items: { type: 'number' } }`
- **WHEN** the registration form shows it
- **THEN** the option row holds a definition list with the pairs `type` / `array`, `minItems` / `1` and `items` / `1 field`, in that order
- **AND** an array of scalars reads as its items joined with `, `, an object as `<n> field` or `<n> fields`, and `null` as `null`

#### Scenario: A constant with other keywords
- **GIVEN** a mode option `strategy` that is `{ const: 'tabu', description: 'Search kind' }`
- **WHEN** the registration form shows it
- **THEN** the option row reads `always tabu` and its definition list holds the single pair `description` / `Search kind`

#### Scenario: Never stringified
- **GIVEN** the options of the four scenarios above
- **WHEN** the registration form text is read
- **THEN** the option rows contain none of `{`, `}` and `"`
- **AND** the raw-rendering detector reports no finding in `frontend/src/pages/RegisterEngine/EngineForm.tsx`

### Requirement: Generated files shown in the catalogue viewer
WHEN the generator preview's `View source` disclosure is open, the preview SHALL show the file chosen in its `File` combobox in `SourceView`, named by the file's name and offering Copy and a Download under that name.

`req~frontend-generator-files-source-view~1`

Needs: impl, utest

The disclosure and the combobox stay, so `frontend/e2e/s5d-workbench.spec.ts` is unchanged (design.md §6).

#### Scenario: The first file
- **GIVEN** a generated instance whose files are `instance.json` and `workflow.bpmn`
- **WHEN** the summary `View source` of the preview is pressed
- **THEN** the combobox `File` has the value `instance.json`
- **AND** a region named `instance.json` contains `"apiVersion": "bim/v1"`, with the buttons `Copy instance.json` and `Download instance.json`

#### Scenario: Another file
- **GIVEN** the open `View source` disclosure of that preview
- **WHEN** `workflow.bpmn` is chosen in the combobox `File`
- **THEN** a region named `workflow.bpmn` contains `<bpmn:definitions/>` and there is no region named `instance.json`
- **AND** the button `Download workflow.bpmn` saves the text as `workflow.bpmn` with type `text/plain`

#### Scenario: A file in a folder
- **GIVEN** a generated file named `resources/candidates.json`
- **WHEN** it is chosen
- **THEN** the region is named `resources/candidates.json` and its download is saved under that same name, `resources/candidates.json`

#### Scenario: Collapsed until asked
- **GIVEN** a generated instance in the preview
- **WHEN** the preview is read before `View source` is pressed
- **THEN** the disclosure is closed and the region `instance.json` is not visible

#### Scenario: Nothing raw in the preview
- **GIVEN** the open `View source` disclosure
- **WHEN** the preview is read
- **THEN** every `<pre>` element in it is inside a `SourceView` region
- **AND** the raw-rendering detector reports no finding in `frontend/src/pages/Generator/LabAside.tsx`

### Requirement: Snapshot source in a Source tab
THE snapshot page SHALL show its compiled form and its package files only in a `Source` tab, beside an `Overview` tab that is selected by default, with the choice between `Compiled form (JSON)` and `Files in the package` kept inside the `Source` tab and both shown with `SourceView`.

`req~frontend-snapshot-source-tab~1`

Needs: impl, utest

Views and file names: design.md §3 as amended by §12.

#### Scenario: The snapshot opens on its overview
- **GIVEN** a snapshot with a stored compiled form
- **WHEN** its page `/app/<org>/<project>/snapshots/<snapshot>` opens
- **THEN** a tab list named `Snapshot views` holds the tabs `Overview` and `Source`, in that order, with `Overview` selected
- **AND** the regions `Fingerprints`, `Exact language used`, `What the engines receive` and `Downloads` are in the tab panel
- **AND** there is no summary `View source` and no region named `Compiled form (JSON)`

#### Scenario: The compiled form in the Source tab
- **GIVEN** the page of snapshot `S` with a stored compiled form
- **WHEN** the tab `Source` is pressed
- **THEN** the group `Source to view` holds the pressed button `Compiled form (JSON)` and the button `Files in the package`
- **AND** a region named `Compiled form (JSON)` contains `"kind": "BindingProblem"`
- **AND** its button `Download Compiled form (JSON)` saves it as `snapshot-S-compiled.json` with type `application/json`

#### Scenario: No compiled form stored
- **GIVEN** a snapshot without a compiled form
- **WHEN** the tab `Source` is pressed
- **THEN** the button `Compiled form (JSON)` is disabled and the text `No compiled form is stored for this snapshot.` is shown

#### Scenario: A file of the package
- **GIVEN** the `Source` tab of a snapshot whose archive holds `bim.yaml` and `resources/tasks.json`
- **WHEN** `Files in the package` is pressed and then the file `resources/tasks.json` is chosen in the list `Files in the package`
- **THEN** a region named `resources/tasks.json`, the file's path, shows the file's text
- **AND** its button `Download resources/tasks.json` saves it as `tasks.json`, the last segment of the path
- **AND** no read-only code editor is on the page

#### Scenario: The archive loads only for the files view
- **GIVEN** a snapshot page, with no download pressed
- **WHEN** the page opens, then the tab `Source` is pressed, then `Files in the package` is pressed
- **THEN** the package archive is not requested before `Files in the package` is pressed, and it is requested once after
- **AND** going back to `Overview` and to `Source` again does not request it while `Compiled form (JSON)` is chosen

#### Scenario: Nothing raw on the page
- **GIVEN** the snapshot page with the `Source` tab open on either view
- **WHEN** the document is read
- **THEN** there is no `<details>` element whose summary reads `View source`
- **AND** every `<pre>` element is inside a `SourceView` region
- **AND** the raw-rendering detector reports no finding in `frontend/src/pages/Cases/SnapshotDetail.tsx`

### Requirement: The M2.5 offenders leave the allow-list
THE frontend hygiene test SHALL find no entry numbered 8, 9, 10, 12, 13, 14 or 15 in `RAW_RENDERING_ALLOW_LIST` and no detector finding in the seven files those offenders named.

`req~frontend-m25-leave-allow-list~1`

Needs: impl, utest

Delivered by tasks.md group D after change `m23-run-result` merges (design.md §8).

#### Scenario: The entries are gone
- **GIVEN** `RAW_RENDERING_ALLOW_LIST` after this change
- **WHEN** the hygiene test reads it
- **THEN** no entry has the offender number 8, 9, 10, 12, 13, 14 or 15
- **AND** no entry has `retiredBy` `M2.5`
- **AND** `MAX_ALLOWED_OFFENDERS` equals the number of entries left

#### Scenario: The seven files are clean
- **GIVEN** `pages/Studies/StudyCell.tsx`, `pages/Studies/StudyDetail.tsx`, `pages/Engines/EngineParts.tsx`, `pages/Organization/OrgAudit.tsx`, `pages/RegisterEngine/EngineForm.tsx`, `pages/Generator/LabAside.tsx` and `pages/Cases/SnapshotDetail.tsx` under `frontend/src`
- **WHEN** the raw-rendering detector reads each
- **THEN** it reports no finding in any of them

#### Scenario: The suite stays green
- **GIVEN** the application sources, `RAW_RENDERING_ALLOW_LIST` and `UNLISTED_FINDINGS` after this change
- **WHEN** `unlistedFindings`, `staleEntries` and `wrongLineNumbers` read them
- **THEN** each returns an empty list
