## ADDED Requirements

### Requirement: Read-only source view
THE `SourceView` component SHALL show a source read-only in a region named by its `label` (a string as given, an object as two-space JSON) in a focusable block, with a `Copy <label>` button whose outcome a status region announces, and a `Download <label>` button only when `filename` is given.

`req~frontend-rendering-source-view~1`

Evidence: `frontend/src/components/rendering/SourceView.test.tsx`

`SourceView` is one of the two components where `<pre>` and `JSON.stringify` are allowed (constitution 15.2). It is used only in a secondary, labelled Source tab or panel, never as the default view; that use is checked by the hygiene requirement below and by ui-qa, not by this component. The `language` prop is informative only (`data-language` on the region); `maxHeight` sets the CSS `max-height` of the `<pre>`.

#### Scenario: String source
- **GIVEN** `<SourceView source={'line one\nline two'} label="BIM source" />`
- **WHEN** it is rendered
- **THEN** a region named `BIM source` contains a `<pre>` whose `<code>` text is `line one\nline two`, line breaks kept

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
- **THEN** a `text/plain` blob is saved through one click on a temporary anchor
- **AND** the object URL is revoked and no `a[download]` element stays in the document

#### Scenario: Download of an object source
- **GIVEN** `<SourceView source={{ a: 1 }} label="Problem" filename="problem.json" />`
- **WHEN** the button named `Download Problem` is pressed
- **THEN** an `application/json` blob is saved under the name `problem.json`

#### Scenario: Keyboard reach
- **GIVEN** `<SourceView source="x" label="Problem" filename="p.txt" />`
- **WHEN** the `<pre>` and the buttons `Copy Problem` and `Download Problem` are focused
- **THEN** the `<pre>` has `tabindex="0"` and each of the three takes focus, with no button at `tabindex="-1"`

#### Scenario: Maximum height
- **GIVEN** `<SourceView source="x" label="Problem" maxHeight="10rem" />`
- **WHEN** it is rendered
- **THEN** the style of the `<pre>` contains `max-height: 10rem`

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/SourceView.css`
- **WHEN** it is read
- **THEN** it contains no hex colour

### Requirement: Collapsed, searchable log panel
THE `LogPanel` component SHALL show a log in a disclosure, closed unless `defaultOpen`, whose summary reads `<title> (<n> lines)`, with a search box that filters the lines case-insensitively, one status region reading `<shown> of <n> lines`, a Copy button for the whole log, a Download button only when `filename` is given, and only `No log` for an empty log.

`req~frontend-rendering-log-panel~1`

Evidence: `frontend/src/components/rendering/LogPanel.test.tsx`

`LogPanel` is the second component where `<pre>` is allowed (constitution 15.3). The title defaults to `Log`; the summary uses `line` for one line. Each shown line keeps its original line number. The buttons are named `Copy <title>` and `Download <title>`; the `<pre>` is named by the title.

#### Scenario: Collapsed by default, open on request
- **GIVEN** `<LogPanel log={LOG} />` and `<LogPanel log={LOG} defaultOpen />`, with `LOG` = `start job\nsolver Alpha ready\nERROR boom\nsolver beta done`
- **WHEN** each is rendered
- **THEN** the first disclosure is closed and the second is open

#### Scenario: Summary with the line count
- **GIVEN** `<LogPanel log={LOG} />`, `<LogPanel log="only" title="Solver output" />` and `<LogPanel log="" />`
- **WHEN** each is rendered
- **THEN** the summaries read `Log (4 lines)`, `Solver output (1 line)` and `Log (0 lines)`

#### Scenario: Empty log
- **GIVEN** `<LogPanel log="" defaultOpen />`
- **WHEN** it is rendered
- **THEN** it shows the text `No log`

#### Scenario: Numbered lines in a named pre
- **GIVEN** `<LogPanel log={LOG} title="Run log" defaultOpen />`
- **WHEN** it is rendered
- **THEN** the element labelled `Run log` is a `<pre>` containing `solver Alpha ready`, with lines numbered `1` to `4`
- **AND** the status region reads `4 of 4 lines`

#### Scenario: Search filters the lines
- **GIVEN** `<LogPanel log={LOG} defaultOpen />`
- **WHEN** `SOLVER` is typed into the input labelled `Search the log`
- **THEN** the `<pre>` shows `solver Alpha ready` and `solver beta done`, not `ERROR boom`, and keeps line number `4` without line `3`
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

#### Scenario: Download only with a file name
- **GIVEN** `<LogPanel log={LOG} defaultOpen />` and `<LogPanel log={LOG} defaultOpen filename="run.log" />`
- **WHEN** each is rendered and Download is pressed on the second
- **THEN** the first offers no Download button
- **AND** the second saves the whole log as a `text/plain` blob named `run.log` and revokes its object URL

#### Scenario: Keyboard reach
- **GIVEN** `<LogPanel log={LOG} defaultOpen filename="run.log" />`
- **WHEN** the summary, the search input, the Copy and Download buttons and the `<pre>` are focused in turn
- **THEN** each of them takes focus

#### Scenario: Long lines scroll and tokens only
- **GIVEN** `frontend/src/components/rendering/LogPanel.css`
- **WHEN** it is read
- **THEN** it declares `overflow: auto` and contains no hex colour

### Requirement: Grouped diagnostics list
THE `DiagnosticsList` component SHALL show a status region with the counts (`3 errors, 1 warning, 1 info`) or `No diagnostics`, and the diagnostics sorted error, warning, info and grouped under a heading per resource (`General` for none), each with its severity as a text badge, code, message, and pointer and hint when given.

`req~frontend-rendering-diagnostics-list~1`

Evidence: `frontend/src/components/rendering/DiagnosticsList.test.tsx`

Severity is never conveyed by colour alone (constitution 11.1): the lowercase words `error`, `warning` and `info` are the badge text. The sort is stable; groups follow the first appearance of their resource after the sort. Each group is a section named by its heading (`headingLevel`, default 3). `info` is never pluralised. Fixture `DIAGS`: `I1` info in `b.yaml`; `E1` error in `b.yaml` with pointer `/a/0` and hint `Fix it`; `W1` warning in `a.yaml`; `E2` error with no resource; `E3` error in `a.yaml`.

#### Scenario: Summary count
- **GIVEN** `DIAGS`, then only `E1` and `W1`, then `W1` twice
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

#### Scenario: Fields shown as text
- **GIVEN** `E1` and `W1`
- **WHEN** the list is rendered
- **THEN** the `E1` item has a badge `error` of variant `error`, `E1` in `<code>`, `Broken thing`, the label `Pointer` with `/a/0` in `<code>`, and `Hint: Fix it`
- **AND** the `W1` item has a badge `warning` of variant `warning` and neither `Pointer` nor `Hint`
- **AND** an info diagnostic shows a badge `info` of variant `info`

#### Scenario: Empty list
- **GIVEN** `<DiagnosticsList diagnostics={[]} />`
- **WHEN** it is rendered
- **THEN** it shows `No diagnostics` and no list item

#### Scenario: Heading level
- **GIVEN** `DIAGS` without `headingLevel`, then with `headingLevel` 2, 4 and 5
- **WHEN** each is rendered
- **THEN** there are three headings at level 3, then three at the given level

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
THE `VerdictBadge` component SHALL show the verdict as text in a badge, give `OPTIMAL`, `FEASIBLE`, `UNSAT`, `TIMEOUT` and `INCOMPATIBLE` the badge variant and plain-language description of design.md §2 through `aria-describedby`, list non-empty reasons in a list named `Reasons`, and show any other value in a `default` badge without description.

`req~frontend-rendering-verdict-badge~1`

Evidence: `frontend/src/components/rendering/VerdictBadge.test.tsx`

The badge never depends on colour alone: the verdict word is always its text. The description is an `.sr-only` element whose id (from `useId`) is referenced by `aria-describedby` on a wrapper `<span>` around the badge.

#### Scenario: Known verdicts
- **GIVEN** each row of: `OPTIMAL` / `success` / `proven best combination`; `FEASIBLE` / `info` / `a valid combination, not proven best`; `UNSAT` / `error` / `no combination satisfies the rules`; `TIMEOUT` / `warning` / `stopped at the time budget`; `INCOMPATIBLE` / `default` / `the engine cannot solve this problem`
- **WHEN** `<VerdictBadge verdict={verdict} />` is rendered
- **THEN** the verdict text has the classes `badge` and `badge-<variant>`
- **AND** the wrapper of the badge has the description as its accessible description, through an `.sr-only` element

#### Scenario: One description id per instance
- **GIVEN** two `<VerdictBadge verdict="OPTIMAL" />`
- **WHEN** they are rendered together
- **THEN** their wrappers reference different `aria-describedby` ids

#### Scenario: Unknown verdict
- **GIVEN** `<VerdictBadge verdict="WEIRD" />`
- **WHEN** it is rendered
- **THEN** the text `WEIRD` is shown in a badge of class `badge-default`
- **AND** no element carries `aria-describedby` and there is no `.sr-only` element

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
THE `MetricCards` component SHALL show non-empty metrics as a list named by `label` (default `Key figures`) with one card per metric holding its label, its value (numbers in en-US with at most three decimals; `null` as a dash read as `no value`), its unit for a non-null value, and its trend and hint as text, and render nothing for no metrics.

`req~frontend-rendering-metric-cards~1`

Evidence: `frontend/src/components/rendering/MetricCards.test.tsx`

Each card is a `<li>` with a `<dl>`: the label in `<dt>`, the value and unit in `<dd>`. The trend is its `label` as visible text with a decorative `aria-hidden` arrow (`↑`, `↓`, `→`); the hint is a `<small>`. The React key is `id`, or the label without one.

#### Scenario: Labelled list
- **GIVEN** `<MetricCards metrics={[{ label: 'Cost', value: 3 }]} />`, then the same with `label="Run totals"`
- **WHEN** each is rendered
- **THEN** there is a list named `Key figures`, then one named `Run totals`

#### Scenario: Cards as definition lists
- **GIVEN** the metrics `{ label: 'Cost', value: 7 }` and `{ label: 'Latency', value: 9, unit: 'ms' }`
- **WHEN** they are rendered
- **THEN** there are two items; the first has a `<dl>` with `<dt>` `Cost` and `<dd>` `7`, the second has `<dd>` `9 ms`, and there is no `<pre>`

#### Scenario: Number format
- **GIVEN** the metrics `{ label: 'Zero', value: 0 }` and `{ label: 'Big', value: 1234.5678 }`
- **WHEN** they are rendered
- **THEN** their values read exactly `0` and `1,234.568`

#### Scenario: String value
- **GIVEN** a metric `{ label: 'Engine', value: 'cp-sat 9.1' }`
- **WHEN** it is rendered
- **THEN** its value reads `cp-sat 9.1`

#### Scenario: Missing value
- **GIVEN** a metric `{ label: 'Gap', value: null }`
- **WHEN** it is rendered
- **THEN** its value shows `—` in an `aria-hidden="true"` element and `no value` in an `.sr-only` element

#### Scenario: Trend as text
- **GIVEN** trends `up` / `+5% vs last run`, `down` / `-2%` and `flat` / `no change`
- **WHEN** they are rendered
- **THEN** each label is visible text and the arrows `↑`, `↓` and `→` are `aria-hidden="true"`

#### Scenario: Hint
- **GIVEN** the metrics `{ label: 'A', value: 1, hint: 'lower is better' }` and `{ label: 'B', value: 2 }`
- **WHEN** they are rendered
- **THEN** the first shows `lower is better` in a `<small>` and the second has no `<small>`

#### Scenario: Same label, different ids
- **GIVEN** the metrics `{ id: 'x', label: 'Cost', value: 1 }` and `{ id: 'y', label: 'Cost', value: 2 }`
- **WHEN** they are rendered
- **THEN** there are two items

#### Scenario: No metrics
- **GIVEN** `<MetricCards metrics={[]} />`
- **WHEN** it is rendered
- **THEN** its container is empty

#### Scenario: Tokens only
- **GIVEN** `frontend/src/components/rendering/MetricCards.css`
- **WHEN** it is read
- **THEN** it contains no hex colour

### Requirement: Raw-rendering hygiene with a shrinking allow-list
IF a source under `frontend/src` other than `SourceView.tsx` and `LogPanel.tsx` has a line with a `<pre` tag or a rendered `JSON.stringify` that `frontend/src/test/rawRenderingAllowList.ts` does not list by file and trimmed text, or a listed line no longer matches its text or line number, THEN the frontend test suite SHALL fail.

`req~frontend-rendering-raw-hygiene~1`

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`

The scanned sources are the `.ts` and `.tsx` files under `frontend/src`, without `*.test.*`, `src/test/**` and test kits; the exempt files are exactly `components/rendering/SourceView.tsx` and `components/rendering/LogPanel.tsx`. Paths in the allow-list are relative to `frontend/src`. The detector is line based, with the limits of design.md §4. The allow-list holds the 15 offenders of ROADMAP M2 (at 912648c) and only shrinks: M2.3–M2.6 remove entries until it is empty. Detector hits that ROADMAP does not list are kept in `UNLISTED_FINDINGS` of the same file for the coordinator to classify. Digest-shaped text and UUIDs (ARCHITECTURE §5.4) are M2.7, not this requirement.

#### Scenario: The detector reports a pre tag
- **GIVEN** the in-memory lines `<pre>{text}</pre>`, `  <pre className="x" aria-label="Log">` and `<pre tabIndex={0}><code>{source}</code></pre>`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each, of kind `pre`

#### Scenario: The detector reports a rendered stringify
- **GIVEN** the in-memory lines `<code>{JSON.stringify(option.rest)}</code>`, `<p>Value: {JSON.stringify(x)}</p>`, `<dd>{a} {JSON.stringify(b)}</dd>`, `<ul>{items.map((i) => JSON.stringify(i))}</ul>`, a child expression `{JSON.stringify(x)}` alone on its line and `<CodeEditor value={JSON.stringify(doc, null, 2)} readOnly />`
- **WHEN** the detector reads each
- **THEN** it reports one finding for each

#### Scenario: The detector ignores stringify that is not rendered
- **GIVEN** in-memory lines with `JSON.stringify` in a request body, `localStorage.setItem`, a `Blob`, a `TextEncoder`, a copy handler `onClick={() => void copy(JSON.stringify(…))}`, a comparison, a template-literal `key`, a helper arrow, a `useMemo`, a `Map` key and a handler block, plus the comment `// <pre>{JSON.stringify(x)}</pre>` and `<preview>{x}</preview>`
- **WHEN** the detector reads each
- **THEN** it reports nothing

#### Scenario: Line number and trimmed text
- **GIVEN** the text `const a = 1;\n    <pre>{a}</pre>`
- **WHEN** the detector reads it
- **THEN** it reports exactly `{ line: 2, text: '<pre>{a}</pre>', kind: 'pre' }`

#### Scenario: Exactly the two rendering components are exempt
- **GIVEN** the line `<pre>{JSON.stringify(x)}</pre>` placed in `components/rendering/SourceView.tsx`, `components/rendering/LogPanel.tsx`, `components/rendering/SourceViewer.tsx`, `pages/components/rendering/SourceView.tsx` and `pages/Jobs/JobResult.tsx`
- **WHEN** the scan reads them
- **THEN** it reports nothing for the first two and one finding for each of the other three
- **AND** both exempt files exist in the sources

#### Scenario: The sources are read
- **GIVEN** the application sources
- **WHEN** the hygiene test collects them
- **THEN** it reads more than 100 files and none under `src/test/`

#### Scenario: A new raw rendering
- **GIVEN** a scanned file with a detector finding whose file and trimmed text match no entry of `RAW_RENDERING_ALLOW_LIST` or `UNLISTED_FINDINGS`
- **WHEN** the frontend test suite runs
- **THEN** it fails with `<file>:<line>  <text>  — render with the catalogue (SourceView, LogPanel, ...) instead of adding an entry to rawRenderingAllowList.ts`

#### Scenario: A fixed offender keeps its entry
- **GIVEN** an allow-list line whose file and text no longer match any detector finding, for example after `pages/Jobs/JobResult.tsx` stops using `<pre>`
- **WHEN** the frontend test suite runs
- **THEN** it fails with `<file>:<line>  <text>  — no longer raw rendering: remove this entry from rawRenderingAllowList.ts`

#### Scenario: Line moved by an edit
- **GIVEN** an allow-listed line that moves from line 31 to line 40 of its file with the same trimmed text
- **WHEN** the frontend test suite runs
- **THEN** the unlisted and stale checks still pass
- **AND** the line-number check fails with `<file>:31 is "<actual text>", expected "<text>"` until the entry says line 40

#### Scenario: Today's offenders are listed
- **GIVEN** the allow-list of this change
- **WHEN** the hygiene test reads it
- **THEN** `MAX_ALLOWED_OFFENDERS` is 15, the list has at most that many entries, and their offender numbers in order are exactly 1 to 15
- **AND** every entry has at least one line and a non-empty reason

#### Scenario: Retiring slices
- **GIVEN** the allow-list of this change
- **WHEN** the hygiene test reads `retiredBy`
- **THEN** offenders 1–4 say `M2.3`, offenders 5, 7 and 11 say `M2.4`, offenders 8–10 and 12–15 say `M2.5`, and offender 6 says `M2.6`

#### Scenario: Unlisted findings
- **GIVEN** `UNLISTED_FINDINGS`
- **WHEN** the hygiene test reads it
- **THEN** every entry has the reason `UNLISTED_REASON` and `retiredBy` `null`, and names no file that an offender entry names
