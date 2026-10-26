## ADDED Requirements

### Requirement: Read-only source view
THE `SourceView` component SHALL show a source read-only in a region named by its `label`, in a focusable block, with a Copy button whose outcome a status region announces, and a Download button only when `filename` is given.

`req~frontend-rendering-source-view~1`

Evidence: `frontend/src/components/rendering/SourceView.test.tsx`

It is one of the two components where `<pre>` and `JSON.stringify` are allowed (constitution 15.2).

#### Scenario: String source
- **GIVEN** `<SourceView source={'line one\nline two'} label="BIM source" />`
- **WHEN** it is rendered
- **THEN** a region named `BIM source` contains a `<pre>` whose `<code>` text is `line one\nline two`, line breaks kept
- **AND** the component is used only in a secondary, labelled Source tab or panel, never as the default view; the hygiene requirement below and ui-qa check that use, not this component

#### Scenario: Object source
- **GIVEN** `<SourceView source={{ a: 1, nested: { b: [true] } }} label="Problem" />`
- **WHEN** it is rendered
- **THEN** the `<code>` text equals `JSON.stringify({ a: 1, nested: { b: [true] } }, null, 2)`

#### Scenario: Empty source
- **GIVEN** `<SourceView source="" label="Problem" />`
- **WHEN** it is rendered
- **THEN** the text `Empty` is shown and there is no `<code>` element inside the `<pre>`

#### Scenario: Language as a data attribute
- **GIVEN** `<SourceView source="x" label="Problem" language="json" />`
- **WHEN** it is rendered
- **THEN** the region named `Problem` has `data-language="json"`
- **AND** the prop is informative only

#### Scenario: Copy
- **GIVEN** `<SourceView source={{ k: 'v' }} label="Problem" />` and a clipboard that accepts writes
- **WHEN** the button named `Copy Problem` is pressed
- **THEN** the clipboard receives `JSON.stringify({ k: 'v' }, null, 2)`
- **AND** the status region, empty before the press, reads `Problem copied`
- **AND** the button text reads `Copied`

#### Scenario: Copy refused by the clipboard
- **GIVEN** `<SourceView source="x" label="Problem" />` and a clipboard that rejects writes
- **WHEN** the button named `Copy Problem` is pressed
- **THEN** the status region reads `Could not copy the Problem`

#### Scenario: Download only with a file name
- **GIVEN** `<SourceView source="x" label="Problem" />` without `filename`
- **WHEN** it is rendered
- **THEN** there is no button named `Download Problem`

#### Scenario: Download of a text source
- **GIVEN** `<SourceView source="plain" label="Problem" filename="problem.txt" />`
- **WHEN** the button named `Download Problem` is pressed
- **THEN** a `text/plain` blob holding `plain` is saved through the shared `saveText` helper of design.md §2, with one click on a temporary anchor
- **AND** no `a[download]` element stays in the document
- **AND** the object URL is not revoked during the click, and is revoked after the pending `setTimeout` 0 runs

#### Scenario: Download of an object source
- **GIVEN** `<SourceView source={{ a: 1 }} label="Problem" filename="problem.json" />`
- **WHEN** the button named `Download Problem` is pressed
- **THEN** an `application/json` blob holding `JSON.stringify({ a: 1 }, null, 2)` is saved under the name `problem.json`

#### Scenario: Keyboard reach
- **GIVEN** `<SourceView source="x" label="Problem" filename="p.txt" />`
- **WHEN** it is rendered
- **THEN** the `<pre>` has `tabindex="0"`
- **AND** neither the button `Copy Problem` nor the button `Download Problem` has `tabindex="-1"`

#### Scenario: Maximum height
- **GIVEN** `<SourceView source="x" label="Problem" maxHeight="10rem" />`
- **WHEN** it is rendered
- **THEN** the style of the `<pre>` contains `max-height: 10rem`

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/SourceView.css`
- **WHEN** it is read
- **THEN** it contains no hex colour

### Requirement: Collapsed, searchable log panel
THE `LogPanel` component SHALL show a log in a disclosure, closed unless `defaultOpen`, with a case-insensitive search box, a status region reading `<shown> of <n> lines`, a Copy button, and a Download button only when `filename` is given.

`req~frontend-rendering-log-panel~1`

Evidence: `frontend/src/components/rendering/LogPanel.test.tsx`

It is the second component where `<pre>` is allowed (constitution 15.3).

#### Scenario: Collapsed by default, open on request
- **GIVEN** `<LogPanel log={LOG} />` and `<LogPanel log={LOG} defaultOpen />`, with `LOG` = `start job\nsolver Alpha ready\nERROR boom\nsolver beta done`
- **WHEN** each is rendered
- **THEN** the first disclosure is closed and the second is open

#### Scenario: Summary with the line count
- **GIVEN** `<LogPanel log={LOG} />`, `<LogPanel log="only" title="Solver output" />` and `<LogPanel log="" />`
- **WHEN** each is rendered
- **THEN** the summaries read `Log (4 lines)`, `Solver output (1 line)` and `Log (0 lines)`
- **AND** the summary reads `<title> (<n> lines)`, the title defaults to `Log`, and `line` is singular for one line

#### Scenario: Empty log
- **GIVEN** `<LogPanel log="" defaultOpen />`
- **WHEN** it is rendered
- **THEN** it shows the text `No log`, and only that

#### Scenario: Numbered lines in a named pre
- **GIVEN** `<LogPanel log={LOG} title="Run log" defaultOpen />`
- **WHEN** it is rendered
- **THEN** the element labelled `Run log` is a `<pre>` containing `solver Alpha ready`, with lines numbered `1` to `4`
- **AND** the status region reads `4 of 4 lines`

#### Scenario: Status for a single line
- **GIVEN** `<LogPanel log="only" defaultOpen />`
- **WHEN** it is rendered
- **THEN** the status region reads exactly `1 of 1 line`

#### Scenario: Search filters the lines
- **GIVEN** `<LogPanel log={LOG} defaultOpen />`
- **WHEN** `SOLVER` is typed into the input labelled `Search the log`
- **THEN** the `<pre>` shows `solver Alpha ready` and `solver beta done`, not `ERROR boom`, and keeps line number `4` without line `3`
- **AND** the visible line numbers read `2` and `4` (`1` to `4` before typing)
- **AND** the status region reads `2 of 4 lines`, and `1 of 4 lines` after typing `error` instead

#### Scenario: No match
- **GIVEN** `<LogPanel log={LOG} defaultOpen />`
- **WHEN** `zzz` is typed into the search input
- **THEN** the text `No lines match` is shown and the status region reads `0 of 4 lines`

#### Scenario: Copy the whole log
- **GIVEN** `<LogPanel log={LOG} defaultOpen />` filtered by `error`
- **WHEN** the Copy button is pressed
- **THEN** the clipboard receives the whole `LOG`, not only the filtered lines
- **AND** the status region announces that the log was copied
- **AND** the buttons are named `Copy <title>` and `Download <title>`, and the `<pre>` is named by the title

#### Scenario: Download only with a file name
- **GIVEN** `<LogPanel log={LOG} defaultOpen />` and `<LogPanel log={LOG} defaultOpen filename="run.log" />`
- **WHEN** each is rendered, and on the second `error` is typed into the search input and Download is pressed
- **THEN** the first offers no Download button
- **AND** the second saves the whole `LOG` as a `text/plain` blob named `run.log`, through the shared `saveText` helper of design.md §2
- **AND** its object URL is not revoked during the click, and is revoked after the pending `setTimeout` 0 runs

#### Scenario: Keyboard reach
- **GIVEN** `<LogPanel log={LOG} defaultOpen filename="run.log" />`
- **WHEN** it is rendered
- **THEN** the `<pre>` labelled `Log` has `tabindex="0"`

#### Scenario: Long lines scroll and tokens only
- **GIVEN** `frontend/src/components/rendering/LogPanel.css`
- **WHEN** it is read
- **THEN** it declares `overflow: auto` and contains no hex colour

### Requirement: Grouped diagnostics list
THE `DiagnosticsList` component SHALL show a status region with the counts or `No diagnostics`, and the diagnostics sorted by severity and grouped by resource and pointer, each with its severity as a text badge, code, message, and pointer and hint when given.

`req~frontend-rendering-diagnostics-list~1`

Evidence: `frontend/src/components/rendering/DiagnosticsList.test.tsx`

Constitution 15.3: diagnostics are "grouped by resource and pointer".

#### Scenario: Summary count
- **GIVEN** fixture `DIAGS`: `I1` info in `b.yaml`; `E1` error in `b.yaml` with pointer `/a/0` and hint `Fix it`; `W1` warning in `a.yaml`; `E2` error with no resource; `E3` error in `a.yaml`; then only `E1` and `W1`, then `W1` twice
- **WHEN** each list is rendered
- **THEN** the status region reads `3 errors, 1 warning, 1 info`, then `1 error, 1 warning`, then `2 warnings` with no `error` or `info`

#### Scenario: Grouped by resource
- **GIVEN** `DIAGS`
- **WHEN** the list is rendered
- **THEN** there are three headings including `a.yaml`, and the section of the heading `General` holds one item, `No resource here`

#### Scenario: Severity order and group order
- **GIVEN** `DIAGS`
- **WHEN** the list is rendered
- **THEN** the item codes read `E1`, `I1`, `E2`, `E3`, `W1` and the headings read `b.yaml`, `General`, `a.yaml`
- **AND** the order is error, warning, info; the sort is stable and groups follow the first appearance of their resource after the sort

#### Scenario: Same pointer kept together inside a resource
- **GIVEN** in resource `r`: `P1a` warning at `/p1`, `P2` error at `/p2`, `P1b` info at `/p1`
- **WHEN** the list is rendered
- **THEN** the item codes read `P2`, `P1a`, `P1b`, in one list

#### Scenario: Pointer groups and items without a pointer
- **GIVEN** in resource `r`, in this order: `N1` info with no pointer, `A1` warning at `/a`, `B1` error at `/b`, `N2` error with no pointer, `B2` info at `/b`, `A2` warning at `/a`
- **WHEN** the list is rendered
- **THEN** the item codes read `B1`, `B2`, `N2`, `N1`, `A1`, `A2`
- **AND** pointer groups follow their first appearance after the sort, and items without a pointer form one group of their own

#### Scenario: Info is never pluralised
- **GIVEN** `I1` twice
- **WHEN** the list is rendered
- **THEN** the status region reads `2 info`

#### Scenario: Fields shown as text
- **GIVEN** `E1` and `W1`
- **WHEN** the list is rendered
- **THEN** the `E1` item has a badge `error` of variant `error`, `E1` in `<code>`, `Broken thing`, the label `Pointer` with `/a/0` in `<code>`, and `Hint: Fix it`
- **AND** the `W1` item has a badge `warning` of variant `warning` and neither `Pointer` nor `Hint`
- **AND** an info diagnostic shows a badge `info` of variant `info`
- **AND** severity is never conveyed by colour alone (constitution 11.1): the lowercase words `error`, `warning` and `info` are the badge text

#### Scenario: Empty list
- **GIVEN** `<DiagnosticsList diagnostics={[]} />`
- **WHEN** it is rendered
- **THEN** it shows `No diagnostics` and no list item

#### Scenario: Heading level
- **GIVEN** `DIAGS` without `headingLevel`, then with `headingLevel` 2, 4 and 5
- **WHEN** each is rendered
- **THEN** there are three headings at level 3 (the default), then three at the given level
- **AND** each group is a section named by its heading

#### Scenario: Sections named by their heading
- **GIVEN** `DIAGS`
- **WHEN** the list is rendered
- **THEN** there is a region named `a.yaml` and no `<pre>`

#### Scenario: Resource names with spaces and a literal General
- **GIVEN** errors with the resources `my file.yaml` and `General`, and one with no resource
- **WHEN** the list is rendered
- **THEN** there is a region named `my file.yaml` and two separate regions named `General`

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/DiagnosticsList.css`
- **WHEN** it is read
- **THEN** it contains no hex colour

### Requirement: Verdict badge
THE `VerdictBadge` component SHALL show the verdict as badge text with the variant and the visually hidden description of design.md §2 for each known verdict, list non-empty reasons in a list named `Reasons`, and show any other value in a `default` badge without description.

`req~frontend-rendering-verdict-badge~1`

Evidence: `frontend/src/components/rendering/VerdictBadge.test.tsx`

#### Scenario: Known verdicts
- **GIVEN** each row of: `OPTIMAL` / `success` / `proven best combination`; `FEASIBLE` / `info` / `a valid combination, not proven best`; `UNSAT` / `error` / `no combination satisfies the rules`; `TIMEOUT` / `warning` / `stopped at the time budget`; `INCOMPATIBLE` / `default` / `the engine cannot solve this problem`
- **WHEN** `<VerdictBadge verdict={verdict} />` is rendered
- **THEN** the verdict text has the classes `badge` and `badge-<variant>`
- **AND** the wrapper of the badge has the text `<verdict>, <description>` and no `aria-describedby`
- **AND** the wrapper contains an `.sr-only` element whose text is `, <description>` right after the verdict, inside the same inline wrapper as the badge, so it is read in the flow as `OPTIMAL, proven best combination`
- **AND** the badge never depends on colour alone: the verdict word is always its text

#### Scenario: Outer element
- **GIVEN** `<VerdictBadge verdict="UNSAT" reasons={['x']} />`
- **WHEN** it is rendered
- **THEN** its outermost element is a `<div>`, so the reasons list is never inside a `<span>`

#### Scenario: Unknown verdict
- **GIVEN** `<VerdictBadge verdict="WEIRD" />`
- **WHEN** it is rendered
- **THEN** the text `WEIRD` is shown in a badge of class `badge-default`
- **AND** the wrapper of the badge has the text `WEIRD` only and there is no `.sr-only` element

#### Scenario: Size
- **GIVEN** `<VerdictBadge verdict="OPTIMAL" />` and `<VerdictBadge verdict="OPTIMAL" size="md" />`
- **WHEN** each is rendered
- **THEN** the badge has the class `badge-sm`, then `badge-md`

#### Scenario: No reasons
- **GIVEN** `<VerdictBadge verdict="UNSAT" />` and `<VerdictBadge verdict="UNSAT" reasons={[]} />`
- **WHEN** each is rendered
- **THEN** there is no list

#### Scenario: Reasons
- **GIVEN** `<VerdictBadge verdict="UNSAT" reasons={['Budget too low', 'No engine']} />`
- **WHEN** it is rendered
- **THEN** a list named `Reasons` holds `Budget too low` and `No engine` in that order, after the badge in document order, and there is no `<pre>`

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/VerdictBadge.css`
- **WHEN** it is read
- **THEN** it contains no hex colour

### Requirement: Metric cards
THE `MetricCards` component SHALL show non-empty metrics as a list named by `label` (default `Key figures`), one card per metric with its label, value, unit for a non-null value, trend and hint as text, and render nothing for no metrics.

`req~frontend-rendering-metric-cards~1`

Evidence: `frontend/src/components/rendering/MetricCards.test.tsx`

#### Scenario: Labelled list
- **GIVEN** `<MetricCards metrics={[{ label: 'Cost', value: 3 }]} />`, then the same with `label="Run totals"`
- **WHEN** each is rendered
- **THEN** there is a list named `Key figures`, then one named `Run totals`

#### Scenario: Cards as definition lists
- **GIVEN** the metrics `{ label: 'Cost', value: 7 }` and `{ label: 'Latency', value: 9, unit: 'ms' }`
- **WHEN** they are rendered
- **THEN** there are two items; the first has a `<dl>` with `<dt>` `Cost` and `<dd>` `7`, the second has `<dd>` `9 ms`, and there is no `<pre>`
- **AND** each card is a `<li>` with a `<dl>`: the label in `<dt>`, the value and unit in `<dd>`

#### Scenario: Number format
- **GIVEN** the metrics `{ label: 'Zero', value: 0 }` and `{ label: 'Big', value: 1234.5678 }`
- **WHEN** they are rendered
- **THEN** their values read exactly `0` and `1,234.568` (numbers in en-US with at most three decimals)

#### Scenario: String value
- **GIVEN** a metric `{ label: 'Engine', value: 'cp-sat 9.1' }`
- **WHEN** it is rendered
- **THEN** its value reads `cp-sat 9.1`

#### Scenario: Missing value
- **GIVEN** a metric `{ label: 'Gap', value: null }`
- **WHEN** it is rendered
- **THEN** its value shows `—` in an `aria-hidden="true"` element and `no value` in an `.sr-only` element (`null` is a dash read as `no value`)

#### Scenario: Trend as text
- **GIVEN** trends `up` / `+5% vs last run`, `down` / `-2%` and `flat` / `no change`
- **WHEN** they are rendered
- **THEN** each label is visible text and the arrows `↑`, `↓` and `→` are decorative and `aria-hidden="true"`

#### Scenario: Hint
- **GIVEN** the metrics `{ label: 'A', value: 1, hint: 'lower is better' }` and `{ label: 'B', value: 2 }`
- **WHEN** they are rendered
- **THEN** the first shows `lower is better` in a `<small>` and the second has no `<small>`

#### Scenario: Missing value without unit
- **GIVEN** a metric `{ label: 'Gap', value: null, unit: 'ms' }`
- **WHEN** it is rendered
- **THEN** its `<dd>` does not contain `ms`

#### Scenario: Same label, different ids
- **GIVEN** the metrics `{ id: 'x', label: 'Cost', value: 1 }` and `{ id: 'y', label: 'Cost', value: 2 }`
- **WHEN** they are rendered
- **THEN** there are two items; the React key is `id`

#### Scenario: Same label without ids
- **GIVEN** the metrics `{ label: 'Cost', value: 1 }` and `{ label: 'Cost', value: 2 }`
- **WHEN** they are rendered
- **THEN** there are two items and nothing is written to `console.error` (no duplicate-key warning)
- **AND** the React key is the label plus the position, so repeated labels need no `id`

#### Scenario: No metrics
- **GIVEN** `<MetricCards metrics={[]} />`
- **WHEN** it is rendered
- **THEN** its container is empty

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/MetricCards.css`
- **WHEN** it is read
- **THEN** it contains no hex colour

### Requirement: Raw-rendering hygiene with a shrinking allow-list
IF a source under `frontend/src` other than `SourceView.tsx` and `LogPanel.tsx` has a `<pre` tag or a rendered `JSON.stringify` line that `frontend/src/test/rawRenderingAllowList.ts` does not list, or a listed line no longer matches, THEN the frontend test suite SHALL fail.

`req~frontend-rendering-raw-hygiene~1`

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`

The detector's known limits are in design.md §4.

#### Scenario: The detector reports a pre tag
- **GIVEN** the in-memory lines `<pre>{text}</pre>`, `  <pre className="x" aria-label="Log">` and `<pre tabIndex={0}><code>{source}</code></pre>`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each, of kind `pre`

#### Scenario: The detector reports a rendered stringify
- **GIVEN** the in-memory lines `<code>{JSON.stringify(option.rest)}</code>`, `<dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>`, `<dd>{ok ? <>{a} <small>{b}</small></> : JSON.stringify(ref)}</dd>`, `<p>Value: {JSON.stringify(x)}</p>`, `<dd>{a} {JSON.stringify(b)}</dd>`, `<ul>{items.map((i) => JSON.stringify(i))}</ul>` and `<CodeEditor value={JSON.stringify(doc, null, 2)} readOnly />`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each

#### Scenario: The detector reports a child expression alone on its line
- **GIVEN** the in-memory lines `  {JSON.stringify(x)}`, `  {typeof v === 'string' ? v : JSON.stringify(v)}`, `  {items.map((i) => JSON.stringify(i))}` and `  {x && JSON.stringify(x)}`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each
- **AND** it reports nothing for the object-literal lines `  { a: JSON.stringify(x) }` and `  { ...JSON.stringify(x) }`

#### Scenario: The detector reports a template literal rendered as a child
- **GIVEN** the in-memory line ``<p>{`Value: ${JSON.stringify(x)}`}</p>``
- **WHEN** the detector reads it
- **THEN** it reports one finding
- **AND** it reports nothing for ``const init = { body: `${JSON.stringify(x)}` };`` and ``<Row key={`${JSON.stringify(a)}`} />``

#### Scenario: The detector skips JSX comment lines
- **GIVEN** the in-memory lines `{/* <pre>{JSON.stringify(x)}</pre> */}` and `{/* a */}<pre>{x}</pre>{/* b */}`
- **WHEN** the detector reads each
- **THEN** it reports nothing for the first and one finding for the second

#### Scenario: The detector ignores stringify that is not rendered
- **GIVEN** in-memory lines with `JSON.stringify` in a request body, `localStorage.setItem`, a `Blob`, a `TextEncoder`, a copy handler `onClick={() => void copy(JSON.stringify(…))}`, a comparison, a template-literal `key`, a helper arrow, a `useMemo`, a `Map` key and a handler block, plus the comment `// <pre>{JSON.stringify(x)}</pre>` and `<preview>{x}</preview>`
- **WHEN** the detector reads each
- **THEN** it reports nothing

#### Scenario: Known limits of the detector are pinned
- **GIVEN** the in-memory samples ``<p>don't {JSON.stringify(x)} isn't</p>``, `<p>{\n  JSON.stringify(x)\n}</p>`, ``<p>{label + `: ${JSON.stringify(x)}`}</p>``, `<Field title={x ?? JSON.stringify(y)} />` and `const tag = "<pre>";`
- **WHEN** the detector reads each
- **THEN** it reports nothing for any of them
- **AND** for `<pre>{JSON.stringify(x)}</pre>` it reports exactly one finding, of kind `pre`
- **AND** the detector is line based, and the tests pinning these limits are named `known limit: …`

#### Scenario: Line number and trimmed text
- **GIVEN** the text `const a = 1;\n    <pre>{a}</pre>`
- **WHEN** the detector reads it
- **THEN** it reports exactly `{ line: 2, text: '<pre>{a}</pre>', kind: 'pre' }`

#### Scenario: Exactly the two rendering components are exempt
- **GIVEN** the line `<pre>{JSON.stringify(x)}</pre>` placed in `components/rendering/SourceView.tsx`, `components/rendering/LogPanel.tsx`, `components/rendering/SourceViewer.tsx`, `pages/components/rendering/SourceView.tsx` and `pages/Jobs/JobResult.tsx`
- **WHEN** the scan reads them
- **THEN** it reports nothing for the first two and one finding for each of the other three
- **AND** both exempt files exist in the sources
- **AND** the exempt files are exactly `components/rendering/SourceView.tsx` and `components/rendering/LogPanel.tsx`

#### Scenario: The sources are read
- **GIVEN** the application sources
- **WHEN** the hygiene test collects them
- **THEN** it reads more than 100 files and none under `src/test/`
- **AND** the scanned sources are the `.ts` and `.tsx` files under `frontend/src`, without `*.test.*`, `src/test/**` and test kits
- **AND** paths in the allow-list are relative to `frontend/src`

#### Scenario: The application sources pass the three checks
- **GIVEN** the application sources and `RAW_RENDERING_ALLOW_LIST` plus `UNLISTED_FINDINGS`
- **WHEN** `unlistedFindings`, `staleEntries` and `wrongLineNumbers` read them
- **THEN** each returns an empty list

#### Scenario: A new raw rendering
- **GIVEN** the synthetic source `pages/New.tsx` with the lines `const a = 1;` and `<pre>{a}</pre>`, and an empty allow-list
- **WHEN** `unlistedFindings` reads them
- **THEN** it returns exactly `pages/New.tsx:2  <pre>{a}</pre>  — render with the catalogue (SourceView, LogPanel, ...) instead of adding an entry to rawRenderingAllowList.ts`

#### Scenario: A fixed offender keeps its entry
- **GIVEN** the synthetic source `pages/Old.tsx` with the line `const a = 1;`, and an entry for `pages/Old.tsx` line 3 `<pre>{a}</pre>`
- **WHEN** `staleEntries` reads them
- **THEN** it returns exactly `pages/Old.tsx:3  <pre>{a}</pre>  — no longer raw rendering: remove this entry from rawRenderingAllowList.ts`

#### Scenario: A listed finding passes
- **GIVEN** the synthetic source `pages/Ok.tsx` with the line `<pre>{a}</pre>`, and an entry for it at line 1
- **WHEN** the three checks read them
- **THEN** each returns an empty list

#### Scenario: Line moved by an edit
- **GIVEN** the synthetic source `pages/Moved.tsx` with the lines `const a = 1;` and `<pre>{a}</pre>`, and an entry for `<pre>{a}</pre>` at line 1
- **WHEN** the three checks read them
- **THEN** `unlistedFindings` and `staleEntries` return empty lists
- **AND** `wrongLineNumbers` returns exactly `pages/Moved.tsx:1 is "const a = 1;", expected "<pre>{a}</pre>"`
- **AND** an entry at line 9 of a one-line file returns `pages/Short.tsx:9 is undefined, expected "<pre>{a}</pre>"`

#### Scenario: A duplicated identical line is unlisted
- **GIVEN** the synthetic source `pages/Dup.tsx` with `<pre>{a}</pre>` at lines 1 and 3, and one entry for line 1
- **WHEN** the checks read them
- **THEN** `unlistedFindings` returns the finding at `pages/Dup.tsx:3` and `staleEntries` returns an empty list
- **AND** findings and listed lines are matched as multisets per (file, trimmed text), so a second identical raw line in a listed file is unlisted

#### Scenario: A removed duplicate is stale
- **GIVEN** the synthetic source `pages/Dup.tsx` with `<pre>{a}</pre>` at line 1 only, and entries for lines 1 and 3 with that text
- **WHEN** the checks read them
- **THEN** `unlistedFindings` returns an empty list and `staleEntries` returns the entry `pages/Dup.tsx:3`
- **AND** two identical lines listed twice pass all three checks
- **AND** a listed duplicate whose copy was removed is stale

#### Scenario: Matching is by file
- **GIVEN** the synthetic source `pages/B.tsx` with `<pre>{a}</pre>`, and an entry for `pages/A.tsx` with the same text
- **WHEN** `unlistedFindings` reads them
- **THEN** it returns one finding

#### Scenario: Today's offenders are listed
- **GIVEN** the allow-list of this change
- **WHEN** the hygiene test reads it
- **THEN** `MAX_ALLOWED_OFFENDERS` is 15, the list has at most that many entries, and their offender numbers in order are exactly 1 to 15
- **AND** every entry has at least one line and a non-empty reason
- **AND** the list holds the 15 offenders of ROADMAP M2 (at 912648c) and only shrinks
- **AND** detector hits that ROADMAP does not list are kept in `UNLISTED_FINDINGS` of the same file for the coordinator to classify
- **AND** digest-shaped text and UUIDs (ARCHITECTURE §5.4) are M2.7, not this requirement

#### Scenario: Retiring slices
- **GIVEN** the allow-list of this change
- **WHEN** the hygiene test reads `retiredBy`
- **THEN** offenders 1–4 say `M2.3`, offenders 5, 7 and 11 say `M2.4`, offenders 8–10 and 12–15 say `M2.5`, and offender 6 says `M2.6`
- **AND** M2.3–M2.6 remove entries until the list is empty

#### Scenario: Unlisted findings
- **GIVEN** `UNLISTED_FINDINGS`
- **WHEN** the hygiene test reads it
- **THEN** every entry has the reason `UNLISTED_REASON` and `retiredBy` `null`, and names no file that an offender entry names
