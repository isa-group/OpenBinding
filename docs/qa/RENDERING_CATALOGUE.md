# Rendering catalogue: foundations (M2.1)

**Status: built and tested (ROADMAP M2.1).** Five components in `frontend/src/components/rendering/` and a hygiene test that
stops new raw rendering. The 9 files that still dump data (8 of the 15 offenders of ROADMAP M2 plus one unlisted finding)
are listed below; the 8 are retired in M2.4 to M2.6, the one waits for classification. Offender 7 and finding 17
went with the decision-space workspace (M2.4, slice 1); offenders 1 to 4 went with M2.3 (the dead engine-answer view,
the Jobs run result, the Workbench result panel and the diagnostic text fallback).

ROADMAP M2.1 asks for the components to be documented in the design system. No separate design-system document exists in
this change, and [ARCHITECTURE §5.3](../ARCHITECTURE.md) is the catalogue table (owned by the coordinator), so this page
documents the five components. Where a column says "Used in" it repeats §5.3.

## Purpose and rule

Render, never dump (constitution Article 15, ADR-0014). A source (BIM, JSON, manifest) appears only in `SourceView`, in a
secondary, labelled tab or behind an explicit download. A log appears only in a collapsed `LogPanel` below the rendered
result. Everything else is shown with the components below. There is no `index.ts`: import each component by path.

## Components

All props are the ones declared in the code; nothing else is accepted.

### SourceView

Read-only source with Copy and, when `filename` is given, Download. Used in: Source tabs.
Used in (Jobs run result): the solution, the engine report and the swaps source, behind "View source".

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `source` | `string \| object` | required | a string as is; an object as JSON indented by 2 |
| `label` | `string` | required | names the region and the buttons ("Copy BIM source") |
| `language` | `string` | none | written to `data-language`; no highlighting |
| `filename` | `string` | none | shows "Download <label>" and saves under this name (`application/json` for objects, `text/plain` otherwise) |
| `maxHeight` | `string` | none | CSS max-height of the scrolling `<pre>` |

```tsx
import { SourceView } from '../../components/rendering/SourceView';
<SourceView source={problem.document} label="BIM source" filename="problem.json" maxHeight="24rem" />
```

Accessibility: a `region` named by `label`; the `<pre>` has `tabIndex=0` so it scrolls by keyboard; the copy result is
announced in a `role="status"` live region and the button text changes (Copied, Failed). Empty text shows "Empty".
The buttons have a 24 px minimum height. Download uses the shared helper `download.ts` (`saveText`), which revokes the
object URL after the click (`setTimeout` 0), not in the same tick.
Avoid: placing it as the main view of a page, or passing already stringified objects.

### LogPanel

Collapsed, searchable log with stable line numbers. Used in: run result, admin errors.
Used in (Jobs run result): the "Engine log" at the end of the run result.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `log` | `string` | required | the whole log; one trailing newline is dropped |
| `title` | `string` | `'Log'` | summary text, `<pre>` name and button names ("Copy Log") |
| `filename` | `string` | none | shows "Download <title>" and saves the whole log as `text/plain` |
| `defaultOpen` | `boolean` | `false` | initial state of the `<details>` |

```tsx
import { LogPanel } from '../../components/rendering/LogPanel';
<LogPanel log={result.logs} title="Engine log" filename="engine.log" />
```

Accessibility: a native `details`/`summary` ("Engine log (120 lines)"); a search input named "Search the log"; a
`role="status"` line "N of M lines" ("1 of 1 line" for a one-line log) that also reports copy results; the `<pre>` is
focusable. Line numbers are `aria-hidden` and stay the original numbers while filtering. Empty log shows "No log"; no
match shows "No lines match". The buttons have a 24 px minimum height; Download uses the same `saveText` helper as
`SourceView`. Avoid: opening it by default above the result.

### DiagnosticsList

Diagnostics grouped by resource and pointer (constitution 15.3), most severe first. Used in: editor, validation,
extensions.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `diagnostics` | `Diagnostic[]` | required | `{ severity: 'error' \| 'warning' \| 'info', code, message, resource?, pointer?, hint? }` |
| `headingLevel` | `2 \| 3 \| 4 \| 5` | `3` | level of the group headings |

```tsx
import { DiagnosticsList } from '../../components/rendering/DiagnosticsList';
<DiagnosticsList diagnostics={report.diagnostics} headingLevel={3} />
```

Accessibility: a `role="status"` summary ("2 errors, 1 warning", or "No diagnostics"); each group is a `section` labelled by
its heading (`resource`, or "General" when absent); severity is a text badge, never colour alone.

Order: the diagnostics are sorted error, warning, info (stable); resources appear in the order of their first item after
that sort. Inside a resource, items with the same `pointer` stay together: pointer groups appear in the order of their
first item after the sort, and items without a pointer form one group of their own. Pointer groups have no heading; a
resource keeps one list. Example in one resource: `N1` info (no pointer), `A1` warning `/a`, `B1` error `/b`, `N2`
error (no pointer), `B2` info `/b`, `A2` warning `/a` are shown as `B1`, `B2`, `N2`, `N1`, `A1`, `A2`.
Avoid: stringifying an item as fallback text.

### VerdictBadge

Outcome of a solve as a text badge. Used in: everywhere a run appears.
Used in (Jobs run result): the verdict at the top of the run result.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `verdict` | `'OPTIMAL' \| 'FEASIBLE' \| 'INFEASIBLE' \| 'UNKNOWN' \| 'UNSAT' \| 'TIMEOUT' \| 'INCOMPATIBLE'` or any string | required | unknown values render as a neutral badge |
| `reasons` | `string[]` | `[]` | listed in a `ul` named "Reasons" |
| `size` | `'sm' \| 'md'` | `'sm'` | badge size |

```tsx
import { VerdictBadge } from '../../components/rendering/VerdictBadge';
<VerdictBadge verdict="INCOMPATIBLE" reasons={['No engine supports LOOP']} />
```

Accessibility: the verdict word is the text; a known verdict adds its description as visually hidden text right after
the verdict, in the same flow and separated by a comma, so a screen reader reads "OPTIMAL, proven best combination". No
`aria-describedby` is used. The outer element is a `div`, so the reasons list is never inside a `span`. Unknown values
(any string outside the seven known verdicts) get no description.
Avoid: showing a verdict only as colour or icon.

### MetricCards

Key figures as cards. Used in: dashboards, problem and study headers.
Used in (Jobs run result): "Quality of this combination", one card per feature of the shown solution.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `metrics` | `Metric[]` | required | `{ id?, label, value: number \| string \| null, unit?, trend?: { direction: 'up' \| 'down' \| 'flat', label }, hint? }`; renders nothing when empty |
| `label` | `string` | `'Key figures'` | name of the list |

```tsx
import { MetricCards } from '../../components/rendering/MetricCards';
<MetricCards metrics={[{ label: 'Cost', value: 12.5, unit: 'EUR', trend: { direction: 'down', label: '3% lower' } }]} />
```

Accessibility: a `ul` with one `dl` per card; numbers use `en-US` with at most 3 decimals; a `null` value shows a dash
(`aria-hidden`) and the hidden text "no value"; the trend is its text label and the arrow is decorative. The React key is
`id`, or the label plus the position when `id` is missing, so repeated labels work without ids. Avoid: formatting
numbers by hand or passing digests as values.

### RunResult

The whole result of a run, for a page to place as it is. Used in: the Jobs page and the Workbench result panel. Import it from
`components/rendering/RunResult`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `result` | `{ termination?, solutions?, logs? }` | required | the job's result as the gateway returns it |
| `problem` | `RunProblem \| null` | `undefined` | `readBindingProblem(document)`; `undefined` while loading (no note), `null` when not available (a note is shown and ids replace names) |
| `constraints` | `unknown` | `[]` | `spec.constraints` of the compiled document, for "QoS against bounds" |
| `report` | `{ remote?: unknown } \| null` | none | the engine report; gives the claimed values, notes and the report source |
| `notice` | `ReactNode` | none | page content right after the summary (for example why a run is infeasible) |
| `children` | `ReactNode` | none | page content after the trade-off set, before the sources |
| `label` | `string` | `'Run result'` | name of the region |

Fixed order of the parts: verdict badge, summary (solution count and optimization type), the "problem not available"
note, `notice`, the solution choice (more than one solution), "Quality of this combination", "Chosen providers",
"QoS against bounds", the objective breakdown, "Claimed and evaluated values", "Trade-off set" (at least two objective
components), `children`, "View source" (the shown solution and the engine report) and the engine log.

```tsx
import { RunResult } from '../../components/rendering/RunResult';
<RunResult result={job.result ?? {}} problem={problem} constraints={constraints} report={report}>
  <NeighborhoodPanel jobId={job.id} />
</RunResult>
```

Avoid: dumping `result` as JSON; the raw document only appears behind "View source".

## Accessibility tests

The component tests use Testing Library roles and accessible names (`getByRole('region', { name })`, `status`, `button`
names). There is no axe-core scan: constitution Article 11 lists it as a GAP and no dependency was added. The CSS of the
five components uses only design tokens, no hex colours; `frontend/src/hygiene.test.ts` enforces it (`#rgb` and `#rrggbb`
in `.css` and `.ts(x)`).

## Hygiene test

`frontend/src/test/rawRenderingHygiene.test.ts` scans `src/**/*.ts(x)` (not tests, not `src/test/**`, not test kits). Only
`components/rendering/SourceView.tsx` and `components/rendering/LogPanel.tsx` may render `<pre>` and stringify an object.

Detector, line based. Comment lines are skipped (`//`, `/*`, `*`, and a line that is only one JSX comment
`{/* … */}`); quoted strings are blanked first.

- A line with a `<pre` tag is a finding.
- `JSON.stringify(` is a finding when it is rendered, that is when the innermost open `{` is: a JSX child expression
  (`<p>Value: {JSON.stringify(x)}</p>`, `<dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>`); a child expression
  alone on its line (`{x && JSON.stringify(x)}`), unless it reads as an object literal (`{ a: …`, `{ ...…`); an attribute
  value that is the call itself (`value={JSON.stringify(doc)}`); or a template literal that is the whole child
  (``<p>{`Value: ${JSON.stringify(x)}`}</p>``).
- Not findings: request bodies, storage, Blob, download and copy calls, comparisons, keys, helpers, handlers, and
  template literals outside a rendered child (a request body, a `key`).

Known limits. Each is pinned by a test named `known limit: …` that asserts the miss, so they are documented gaps, not
intended behaviour; ui-qa screenshots catch what the detector does not:

1. An apostrophe in JSX text is read as a string quote and hides what follows on that line
   (``<p>don't {JSON.stringify(x)} isn't</p>`` is not reported).
2. A template literal that is only part of a larger child expression is not seen
   (``<p>{label + `: ${JSON.stringify(x)}`}</p>``).
3. A `JSON.stringify` on a different line from the `{` that opened its expression is not seen.
4. A call wrapped inside an attribute value is not seen (`<Field title={x ?? JSON.stringify(y)} />`).
5. A `<pre` inside a string literal is not reported (`const tag = "<pre>";`).
6. A line with both a `<pre` tag and a rendered stringify counts as one finding.

Also not seen: raw rendering built without the literal `<pre` or `JSON.stringify(` (`React.createElement('pre')`,
`white-space: pre`, or a stringified variable shown elsewhere, as at `RepDetail.tsx:77`, whose `sourceText` reaches
the textarea at :317).

The allow-list `frontend/src/test/rawRenderingAllowList.ts` holds the 1 remaining offender of ROADMAP M2 (`RAW_RENDERING_ALLOW_LIST`)
and `UNLISTED_FINDINGS` for 1 finding not in the roadmap, awaiting classification: `pages/Workbench/SourcePanel.tsx`
(diff `<pre>`). Findings and listed lines are matched as a
multiset per file and trimmed line text: a second identical raw line in a listed file is a new finding, and a listed
duplicate whose copy was removed is stale. The test fails on a new finding (`unlistedFindings`), on a stale entry
(`staleEntries`; the list may only shrink) and on a wrong `line` (`wrongLineNumbers`). The three functions are exported
from the test file and tested with synthetic sources as well as run on the real ones.

To retire an offender, in the slice that owns it: replace the raw block with the catalogue component, delete its entry,
lower `MAX_ALLOWED_OFFENDERS`, and in the first such slice relax the "numbered 1 to 15" assertion to a subset (done in slice 1; the numbers still in use are those of the table below).

| Slice | Offenders (file under `frontend/src`) |
|---|---|
| M2.3 | none left (1 `EngineReportView.tsx`, 2 `pages/Jobs/JobResult.tsx`, 3 `pages/Workbench/RunPanel.tsx` and 4 `pages/Workbench/CheckResult.tsx` are retired) |
| M2.4 | none left (5 `pages/Reports/RepDetail.tsx` and 11 `pages/Library/ContentView.tsx` are retired) |
| M2.5 | none left (8 `pages/Studies/StudyCell.tsx`, 9 `pages/Studies/StudyDetail.tsx`, 10 `pages/Engines/EngineParts.tsx`, 12 `pages/Organization/OrgAudit.tsx`, 13 `pages/RegisterEngine/EngineForm.tsx`, 14 `pages/Generator/LabAside.tsx` and 15 `pages/Cases/SnapshotDetail.tsx` are retired) |
| M2.6 | 6 `pages/Reports/Verifier.tsx` |
| none yet | 16 `pages/Workbench/SourcePanel.tsx` |

## Not yet

- No syntax highlighting: `language` is only a data attribute.
- No virtualised logs: `LogPanel` renders every line, so very large logs are heavy.
- Digest and UUID detection is M2.7 (with `CitationPanel` and `VerifyResult`).
- The QA gallery is M2.8.
- The other §5.3 components (`ProblemSummary`, `WorkflowGraph`, `BindingTable`, ...) are not built.
