## ADDED Requirements

### Requirement: Read-only source view
THE `SourceView` component SHALL show a source read-only in a keyboard-focusable region named by its `label`, with a Copy button, a Download button only when a `filename` is given, and an object source pretty-printed as JSON with two-space indentation.

`req~frontend-rendering-source-view~1`

Evidence: `frontend/src/components/rendering/SourceView.test.tsx`

`SourceView` is one of the two components where `<pre>` and `JSON.stringify` are allowed (constitution 15.2). It is used only in a secondary, labelled Source tab or panel, never as the default view; that use is checked by the hygiene requirement below and by ui-qa, not by this component.

#### Scenario: String source
- **GIVEN** `<SourceView source="tasks: 3" label="BIM source" />`
- **WHEN** it is rendered
- **THEN** a region named `BIM source` contains the text `tasks: 3`
- **AND** the code block is in the tab order (`tabIndex` 0) and offers no way to edit the text

#### Scenario: Object source
- **GIVEN** `<SourceView source={{ a: 1, b: [2] }} label="Manifest" />`
- **WHEN** it is rendered
- **THEN** the code block text equals `JSON.stringify({ a: 1, b: [2] }, null, 2)`

#### Scenario: Copy
- **GIVEN** a `SourceView` with label `Manifest` and a clipboard that accepts writes
- **WHEN** the button `Copy Manifest` is pressed
- **THEN** the clipboard receives the shown text
- **AND** a status region announces that it was copied

#### Scenario: Copy refused by the clipboard
- **GIVEN** a `SourceView` with label `Manifest` and a clipboard that rejects writes
- **WHEN** the button `Copy Manifest` is pressed
- **THEN** the status region announces that the copy failed

#### Scenario: Download only with a file name
- **GIVEN** one `SourceView` with label `Manifest` and `filename="manifest.json"`, and another without `filename`
- **WHEN** both are rendered
- **THEN** the first offers a button `Download Manifest` that saves the shown text as `manifest.json`
- **AND** the second offers no Download button

### Requirement: Collapsed, searchable log panel
THE `LogPanel` component SHALL show a log in a disclosure collapsed by default whose summary gives the title and line count, with a search box that filters the lines and announces `N of M lines` in a status region, a Copy button, a Download button only when a `filename` is given, and the text `No log` for an empty log.

`req~frontend-rendering-log-panel~1`

Evidence: `frontend/src/components/rendering/LogPanel.test.tsx`

`LogPanel` is the second component where `<pre>` is allowed (constitution 15.3). The title defaults to `Log`; `defaultOpen` opens the disclosure on first render.

#### Scenario: Collapsed by default with the line count
- **GIVEN** `<LogPanel log={"start\nsolve\ndone"} />`
- **WHEN** it is rendered
- **THEN** the disclosure is closed and its summary reads `Log (3 lines)`

#### Scenario: Opened on request
- **GIVEN** `<LogPanel log={"a"} title="Engine log" defaultOpen />`
- **WHEN** it is rendered
- **THEN** the disclosure is open and its summary reads `Engine log (1 line)`

#### Scenario: Search filters the lines
- **GIVEN** an open `LogPanel` with the log `start\nsolve error\ndone\nerror 2`
- **WHEN** `error` is typed into the input labelled `Search the log`
- **THEN** only the lines `solve error` and `error 2` are shown
- **AND** the status region reads `2 of 4 lines`

#### Scenario: Copy and Download
- **GIVEN** a `LogPanel` with `filename="run-14.log"`, and another without `filename`
- **WHEN** both are rendered and Copy is pressed on the first
- **THEN** the clipboard receives the whole log, not only the filtered lines
- **AND** only the first offers a Download button, which saves the log as `run-14.log`

#### Scenario: Empty log
- **GIVEN** `<LogPanel log="" />`
- **WHEN** it is rendered and opened
- **THEN** it shows the text `No log` and no empty code block

### Requirement: Grouped diagnostics list
THE `DiagnosticsList` component SHALL group diagnostics by resource (those without one under `General`), order errors before warnings before info, show each severity as text with its code, message, pointer and hint, and show a summary count, or `No diagnostics` when the list is empty.

`req~frontend-rendering-diagnostics-list~1`

Evidence: `frontend/src/components/rendering/DiagnosticsList.test.tsx`

Severity is never conveyed by colour alone (constitution 11.1): the words `Error`, `Warning` and `Info` are part of the text. Within one severity the input order is kept. Group headings use `headingLevel` (default 3).

#### Scenario: Grouped by resource
- **GIVEN** diagnostics `{severity: 'error', code: 'BIM-101', message: 'Unknown task', resource: 'workflow.yaml', pointer: '/tasks/2'}` and `{severity: 'info', code: 'BIM-900', message: 'Profile inferred'}`
- **WHEN** the list is rendered
- **THEN** there is a level-3 heading `workflow.yaml` above the `BIM-101` item and a level-3 heading `General` above the `BIM-900` item

#### Scenario: Severity order
- **GIVEN** in one resource an `info`, then a `warning`, then an `error` diagnostic
- **WHEN** the list is rendered
- **THEN** the items appear in the order error, warning, info

#### Scenario: Fields shown as text
- **GIVEN** a warning with code `BIM-204`, message `Bound is loose`, pointer `/constraints/0` and hint `Tighten the bound`
- **WHEN** the list is rendered
- **THEN** its item contains the texts `Warning`, `BIM-204`, `Bound is loose`, `/constraints/0` and `Tighten the bound`

#### Scenario: Summary count
- **GIVEN** two errors, one warning and no info
- **WHEN** the list is rendered
- **THEN** the summary reads `2 errors, 1 warning`

#### Scenario: Empty list
- **GIVEN** `<DiagnosticsList diagnostics={[]} />`
- **WHEN** it is rendered
- **THEN** it shows `No diagnostics` and no list

### Requirement: Verdict badge
THE `VerdictBadge` component SHALL show the verdict `OPTIMAL`, `FEASIBLE`, `UNSAT`, `TIMEOUT` or `INCOMPATIBLE` as text with a plain-language accessible description, list the reasons when given, and show any other value as a neutral badge with that value as its text.

`req~frontend-rendering-verdict-badge~1`

Evidence: `frontend/src/components/rendering/VerdictBadge.test.tsx`

The descriptions are fixed in design.md §3. The badge never depends on colour alone: the verdict word is always visible.

#### Scenario: Known verdict
- **GIVEN** `<VerdictBadge verdict="UNSAT" />`
- **WHEN** it is rendered
- **THEN** the text `UNSAT` is visible
- **AND** its accessible description is `No binding satisfies the hard constraints`

#### Scenario: Each known verdict has a description
- **GIVEN** each of `OPTIMAL`, `FEASIBLE`, `UNSAT`, `TIMEOUT` and `INCOMPATIBLE`
- **WHEN** a badge is rendered for it
- **THEN** it shows the verdict as text and has a non-empty accessible description different from the verdict word

#### Scenario: Reasons
- **GIVEN** `<VerdictBadge verdict="INCOMPATIBLE" reasons={['loops not supported', 'soft constraints not supported']} />`
- **WHEN** it is rendered
- **THEN** a list with the two reasons, in that order, is shown next to the badge

#### Scenario: Unknown verdict
- **GIVEN** `<VerdictBadge verdict="ERROR_X" />`
- **WHEN** it is rendered
- **THEN** the text `ERROR_X` is visible in a badge of the neutral (`default`) variant
- **AND** no exception is thrown

### Requirement: Metric cards
THE `MetricCards` component SHALL show its metrics as a labelled list of cards, each with its label, formatted value, unit and optional trend text, and an em dash (`—`) in place of a missing value.

`req~frontend-rendering-metric-cards~1`

Evidence: `frontend/src/components/rendering/MetricCards.test.tsx`

Numbers are formatted with `Intl.NumberFormat('en')` (design.md §3). The trend is text, never only an arrow or a colour.

#### Scenario: Labelled list
- **GIVEN** `<MetricCards label="Problem metrics" metrics={[{label: 'Tasks', value: 12}, {label: 'Candidates', value: 1200}]} />`
- **WHEN** it is rendered
- **THEN** a list named `Problem metrics` has two items
- **AND** the second item shows `Candidates` and `1,200`

#### Scenario: Unit and trend
- **GIVEN** a metric `{label: 'Latency', value: 41.5, unit: 'ms', trend: {direction: 'down', label: '12% lower than v2'}}`
- **WHEN** it is rendered
- **THEN** its card shows `Latency`, `41.5`, `ms` and `12% lower than v2`

#### Scenario: Missing value
- **GIVEN** a metric `{label: 'Gap', value: null}`
- **WHEN** it is rendered
- **THEN** its card shows `—` as the value and no unit

#### Scenario: String value
- **GIVEN** a metric `{label: 'Profile', value: 'qos-basic'}`
- **WHEN** it is rendered
- **THEN** its card shows `qos-basic` unchanged

### Requirement: Raw-rendering hygiene with a shrinking allow-list
IF a `<pre>` or a rendered `JSON.stringify` outside `components/rendering/SourceView.tsx` and `components/rendering/LogPanel.tsx` is missing from `frontend/src/test/rawRenderingAllowList.ts`, an allow-list entry no longer matches, or an offender entry lies outside the 15 offender files of ROADMAP M2, THEN the frontend test suite SHALL fail.

`req~frontend-rendering-raw-hygiene~1`

Evidence: `frontend/src/test/rawRenderingHygiene.test.ts`

The allow-list starts with entries for all 15 offenders of ROADMAP M2 (at 912648c), each tagged with its offender number, and may only shrink: M2.3–M2.6 remove entries until it is empty. Detector hits that are not among the 15 are kept in a separate `UNLISTED_FINDINGS` array of the same file and reported to the coordinator (design.md §4). Entries are matched by file and trimmed line text, not by line number. Digest-shaped text and UUIDs (ARCHITECTURE §5.4) are M2.7, not this requirement.

#### Scenario: A new raw rendering
- **GIVEN** a page `frontend/src/pages/Example.tsx` that renders `<pre>{JSON.stringify(data)}</pre>` and no allow-list entry for it
- **WHEN** the frontend test suite runs
- **THEN** it fails and names `frontend/src/pages/Example.tsx` and the offending line text

#### Scenario: The two rendering components are exempt
- **GIVEN** `<pre>` and `JSON.stringify` in `frontend/src/components/rendering/SourceView.tsx` and `<pre>` in `frontend/src/components/rendering/LogPanel.tsx`
- **WHEN** the frontend test suite runs
- **THEN** the hygiene test does not report them

#### Scenario: Today's offenders are listed
- **GIVEN** the allow-list of this change
- **WHEN** its offender entries are grouped by offender number
- **THEN** the numbers are exactly 1 to 15 and every entry names the file ROADMAP M2 gives for its number

#### Scenario: A fixed offender keeps its entry
- **GIVEN** an allow-list entry whose file no longer contains its line text, for example after `JobResult.tsx` stops using `<pre>`
- **WHEN** the frontend test suite runs
- **THEN** it fails and asks for the stale entry to be removed

#### Scenario: Line moved by an edit
- **GIVEN** an allow-listed line that moves from line 31 to line 40 of its file with the same trimmed text
- **WHEN** the frontend test suite runs
- **THEN** the hygiene test still passes

#### Scenario: Allow-list grows outside the offenders
- **GIVEN** an offender entry added for `frontend/src/pages/Home/Home.tsx`, which is not one of the 15 offender files
- **WHEN** the frontend test suite runs
- **THEN** it fails

#### Scenario: Detector controls
- **GIVEN** in-memory samples `<pre className="x">`, `{JSON.stringify(value, null, 2)}` and a line without either
- **WHEN** the detector of the hygiene test reads them
- **THEN** it reports the first two and not the third
