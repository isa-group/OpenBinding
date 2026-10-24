# Rendering catalogue: foundations (M2.1)

**Status: built and tested (ROADMAP M2.1).** Five components in `frontend/src/components/rendering/` and a hygiene test that
stops new raw rendering. The 17 screens that still dump data are listed below and are retired in M2.3 to M2.6.

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

Read-only source with Copy and, when `filename` is given, Download. Used in: only in Source tabs.

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
Avoid: placing it as the main view of a page, or passing already stringified objects.

### LogPanel

Collapsed, searchable log with stable line numbers. Used in: run result, admin errors.

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
`role="status"` line "N of M lines" that also reports copy results; the `<pre>` is focusable. Line numbers are
`aria-hidden` and stay the original numbers while filtering. Empty log shows "No log"; no match shows "No lines match".
Avoid: opening it by default above the result.

### DiagnosticsList

Diagnostics grouped by resource, most severe first. Used in: editor, validation, extensions.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `diagnostics` | `Diagnostic[]` | required | `{ severity: 'error' \| 'warning' \| 'info', code, message, resource?, pointer?, hint? }` |
| `headingLevel` | `2 \| 3 \| 4 \| 5` | `3` | level of the group headings |

```tsx
import { DiagnosticsList } from '../../components/rendering/DiagnosticsList';
<DiagnosticsList diagnostics={report.diagnostics} headingLevel={3} />
```

Accessibility: a `role="status"` summary ("2 errors, 1 warning", or "No diagnostics"); each group is a `section` labelled by
its heading (`resource`, or "General" when absent); severity is a text badge, never colour alone. Avoid: stringifying an
item as fallback text.

### VerdictBadge

Outcome of a solve as a text badge. Used in: everywhere a run appears.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `verdict` | `'OPTIMAL' \| 'FEASIBLE' \| 'UNSAT' \| 'TIMEOUT' \| 'INCOMPATIBLE'` or any string | required | unknown values render as a neutral badge |
| `reasons` | `string[]` | `[]` | listed in a `ul` named "Reasons" |
| `size` | `'sm' \| 'md'` | `'sm'` | badge size |

```tsx
import { VerdictBadge } from '../../components/rendering/VerdictBadge';
<VerdictBadge verdict="INCOMPATIBLE" reasons={['No engine supports LOOP']} />
```

Accessibility: the verdict word is the text; a known verdict adds a visually hidden description (for example "proven best
combination" for OPTIMAL) linked with `aria-describedby`. Avoid: showing a verdict only as colour or icon.

### MetricCards

Key figures as cards. Used in: dashboards, problem and study headers.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `metrics` | `Metric[]` | required | `{ id?, label, value: number \| string \| null, unit?, trend?: { direction: 'up' \| 'down' \| 'flat', label }, hint? }`; renders nothing when empty |
| `label` | `string` | `'Key figures'` | name of the list |

```tsx
import { MetricCards } from '../../components/rendering/MetricCards';
<MetricCards metrics={[{ label: 'Cost', value: 12.5, unit: 'EUR', trend: { direction: 'down', label: '3% lower' } }]} />
```

Accessibility: a `ul` with one `dl` per card; numbers use `en-US` with at most 3 decimals; a `null` value shows a dash
(`aria-hidden`) and the hidden text "no value"; the trend is its text label and the arrow is decorative. `id` is the React
key when labels repeat. Avoid: formatting numbers by hand or passing digests as values.

## Accessibility tests

The component tests use Testing Library roles and accessible names (`getByRole('region', { name })`, `status`, `button`
names). There is no axe-core scan: constitution Article 11 lists it as a GAP and no dependency was added. The CSS of the
five components uses only design tokens, no hex colours; `frontend/src/hygiene.test.ts` enforces it (`#rgb` and `#rrggbb`
in `.css` and `.ts(x)`).

## Hygiene test

`frontend/src/test/rawRenderingHygiene.test.ts` scans `src/**/*.ts(x)` (not tests, not `src/test/**`, not test kits). Only
`components/rendering/SourceView.tsx` and `components/rendering/LogPanel.tsx` may render `<pre>` and stringify an object.

Detector, line based: a line with a `<pre` tag is a finding; `JSON.stringify(` is a finding when the innermost open `{` is a
JSX child expression or an attribute value that is the call itself. Request bodies, storage, Blob and copy calls,
comparisons, keys and template literals are not findings. Limit: a call on a different line from the `{` that opened its
expression is not seen; comment lines are skipped.

The allow-list `frontend/src/test/rawRenderingAllowList.ts` holds the 15 offenders of ROADMAP M2 (`RAW_RENDERING_ALLOW_LIST`),
matched by file plus trimmed line text, and `UNLISTED_FINDINGS` for 2 findings not in the roadmap, awaiting classification:
`pages/Workbench/SourcePanel.tsx` (diff `<pre>`) and `pages/Analysis/SavedDecision.tsx` (stringified reference). The test
fails on a new finding, on a stale entry (the list may only shrink) and on a wrong `line`.

To retire an offender, in the slice that owns it: replace the raw block with the catalogue component, delete its entry,
lower `MAX_ALLOWED_OFFENDERS`, and in the first such slice relax the "numbered 1 to 15" assertion to a subset.

| Slice | Offenders (file under `frontend/src`) |
|---|---|
| M2.3 | 1 `components/EngineReportView/EngineReportView.tsx`; 2 `pages/Jobs/JobResult.tsx`; 3 `pages/Workbench/RunPanel.tsx`; 4 `pages/Workbench/CheckResult.tsx` |
| M2.4 | 5 `pages/Reports/RepDetail.tsx`; 7 `pages/Analysis/Inspector.tsx`; 11 `pages/Library/ContentView.tsx` |
| M2.5 | 8 `pages/Studies/StudyCell.tsx`; 9 `pages/Studies/StudyDetail.tsx`; 10 `pages/Engines/EngineParts.tsx`; 12 `pages/Organization/OrgAudit.tsx`; 13 `pages/RegisterEngine/EngineForm.tsx`; 14 `pages/Generator/LabAside.tsx`; 15 `pages/Cases/SnapshotDetail.tsx` |
| M2.6 | 6 `pages/Reports/Verifier.tsx` |
| none yet | 16 `pages/Workbench/SourcePanel.tsx`; 17 `pages/Analysis/SavedDecision.tsx` |

## Not yet

- No syntax highlighting: `language` is only a data attribute.
- No virtualised logs: `LogPanel` renders every line, so very large logs are heavy.
- Digest and UUID detection is M2.7 (with `CitationPanel` and `VerifyResult`).
- The QA gallery is M2.8.
- The other §5.3 components (`ProblemSummary`, `WorkflowGraph`, `BindingTable`, ...) are not built.
