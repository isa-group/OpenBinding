# Design: m21-rendering-catalogue

Status: S1–S4 built (the five components, their tests, the hygiene test with its allow-list and the catalogue page
`docs/qa/RENDERING_CATALOGUE.md`), including the fixes of review round 1 of PR 38; S5 (review sign-off, archive) is
open. This file describes what is built. Fixed inputs: ROADMAP M2.1 and M2.2 with
its list of 15 offenders at 912648c, ARCHITECTURE §5.3 (catalogue) and §5.4 (identifiers), ADR-0014, constitution
Articles 1, 11 and 15.

## 1. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Where the components live | flat files under `frontend/src/components/rendering/` (`SourceView.tsx`, `SourceView.css`, `SourceView.test.tsx`, …), imported by path, with no `index.ts`, like `components/ui` | `shared/ui` of ARCHITECTURE §5.1: that layout does not exist yet; the folder moves with `components/ui` when it lands. A barrel `index.ts`: `components/ui` has none, and a barrel would hide which file the hygiene exemption names |
| Building blocks | reuse `components/ui` `Badge` (verdicts, severities) and `useCopy` (clipboard and its `idle`/`copied`/`failed` status); the Copy and Download controls are plain `<button>` elements of the components, not `ui` `Action`; empty states are plain text, not `EmptyState`; the `.sr-only` class and the tokens of `styles/globals.css` | `Action` and `EmptyState`: not needed for a small bar of two buttons and one-line empty texts. New colours: every component stylesheet is tested to hold no hex colour |
| Dependencies | none added; `frontend/package.json` and the lockfile are unchanged | `axe-core`/`vitest-axe` for an automated scan, `@testing-library/user-event` for typing: both are new dependencies (constitution 11 keeps the axe scan a GAP) |
| Accessibility tests | Testing Library queries by role and accessible name (`region`, `button`, `status`, `list`, `listitem`, `heading` with `level`), `getByLabelText`, text content of visually hidden elements, `fireEvent` for input and clicks, and tab-order checks by attribute (`tabindex="0"` on each `<pre>`, no button at `tabindex="-1"`) | an automated WCAG scan (new dependency); `focus()` then `toHaveFocus` checks: the tests do not use them |
| Hygiene test | a new file `frontend/src/test/rawRenderingHygiene.test.ts` with its data in `frontend/src/test/rawRenderingAllowList.ts` | extending `frontend/src/hygiene.test.ts` (named by ADR-0014 and constitution 15 as "to extend"): that file is about theme and persona, and a separate data file keeps the shrinking list reviewable on its own. The constitution's `Enforced:` line is updated by the owner |
| Download | one shared helper `saveText(text, filename, mime)` in `components/rendering/download.ts`, used by `SourceView` and `LogPanel`: a `Blob` of the text, an object URL and a temporary `<a download={filename}>` appended, clicked and removed; the URL is revoked in a `setTimeout(…, 0)` after the click, not in the same tick, so browsers that start the download asynchronously still read it | a server endpoint: exports already exist where they are needed, and the components must work offline. Revoking in the same tick: some browsers (Safari, older Firefox) can then lose the download. One copy of the code per component: duplicated |
| Text | English, in the components (constitution 12) | an i18n layer: none exists |

## 2. Component contracts

All are named exports of their own file under `frontend/src/components/rendering/`; each imports its own CSS. Only
`Diagnostic` and `Metric` are exported types; the props interfaces are file-local.

```ts
// SourceView.tsx
interface SourceViewProps {
  source: string | object;   // a string as given; an object as JSON.stringify(source, null, 2)
  label: string;             // names the region and the buttons
  language?: string;         // informative only: data-language on the <section>; no highlighting
  filename?: string;         // Download is offered only when this is given
  maxHeight?: string;        // CSS max-height of the <pre>, e.g. '24rem'
}
export function SourceView(props: SourceViewProps);
```

Markup: `<section role="region" aria-label={label} data-language={language}>` holding a bar and the code block. The
bar has a `<button aria-label="Copy {label}">` whose text is `Copy`, `Copied` or `Failed` from `useCopy().status()`, a
`<button aria-label="Download {label}">Download</button>` only with `filename`, and an `.sr-only` `role="status"`
span that reads `{label} copied`, `Could not copy the {label}` or nothing when idle. The code block is
`<pre tabIndex={0}>` with `<code>{text}</code>`, or `<span>Empty</span>` (no `<code>`) when the text is empty. Copy
writes the shown text. Download calls `saveText` (`download.ts`, §1) with `application/json` for an object source and
`text/plain` for a string. The bar buttons have `min-height: 24px` (constitution 11.2; not asserted by a test).

```ts
// LogPanel.tsx
interface LogPanelProps {
  log: string;
  title?: string;            // default 'Log'
  filename?: string;         // Download only when given
  defaultOpen?: boolean;     // default false
}
export function LogPanel(props: LogPanelProps);
```

Markup: `<details open={defaultOpen}>` with `<summary>{title} ({n} lines)</summary>` (`line` when `n` is 1). The
lines are `log` split on `\n` or `\r\n` after removing one trailing line break; an empty log has 0 lines. With 0
lines the disclosure holds only `<p>No log</p>`. Otherwise it holds a bar (an `<input type="search">` labelled
`Search the log`, the button `Copy {title}` with text `Copy`/`Copied`/`Failed`, and `Download {title}` only with
`filename`), then one `<p role="status">` reading `{shown} of {n} lines` (`1 of 1 line` when `n` is 1), followed by
` · {title} copied` or ` · Could not copy the {title}` after a copy, then either `<p>No lines match</p>` or
`<pre aria-label={title} tabIndex={0}>` with one `<span data-line={number}>` per shown line, its original number in an
`aria-hidden` span. The filter is a case-insensitive substring match; Copy and Download (`saveText` with `text/plain`)
always use the whole log. Long lines scroll (`overflow: auto` in `LogPanel.css`). The bar buttons have
`min-height: 24px` (constitution 11.2; not asserted by a test).

```ts
// DiagnosticsList.tsx
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  resource?: string;         // grouping key; missing or empty → the group headed 'General'
  pointer?: string;          // e.g. a JSON pointer '/tasks/2'
  hint?: string;
}
interface DiagnosticsListProps {
  diagnostics: Diagnostic[];
  headingLevel?: 2 | 3 | 4 | 5;   // level of the group headings, default 3
}
export function DiagnosticsList(props: DiagnosticsListProps);
```

Markup: a `<p role="status">` with the summary (`3 errors, 1 warning, 1 info`: zero counts left out, `error` and
`warning` singular for one, `info` never pluralised) or `No diagnostics` when the list is empty. The diagnostics are
sorted error, warning, info (stable) and then grouped by resource in order of first appearance after the sort. Inside
a resource, items with the same pointer are kept together (constitution 15.3, "grouped by resource and pointer"): the
pointer groups follow their first appearance after the severity sort, so the group of the most severe item comes first,
and the items without a pointer form one group of their own, placed the same way. Pointer groups have no heading of
their own; all items of a resource stay in its one `<ul>`. Example: `N1` info (no pointer), `A1` warning `/a`, `B1`
error `/b`, `N2` error (no pointer), `B2` info `/b`, `A2` warning `/a` render as `B1`, `B2`, `N2`, `N1`, `A1`, `A2`. Each
group is a `<section aria-labelledby>` pointing to its heading at `headingLevel`, whose id comes from `useId` plus the
group index; the heading text is the resource or `General`. Items with no resource form their own group, separate from
a resource literally named `General`. Each `<li>`: a `Badge` whose text and variant are the lowercase severity
(`error`, `warning`, `info`), the code in `<code>`, the message, `Pointer` with the pointer in `<code>` when given, and
`Hint: {hint}` when given. No `<pre>`.

```ts
// VerdictBadge.tsx
interface VerdictBadgeProps {
  verdict: 'OPTIMAL' | 'FEASIBLE' | 'UNSAT' | 'TIMEOUT' | 'INCOMPATIBLE' | (string & {});
  reasons?: string[];
  size?: 'sm' | 'md';        // passed to Badge, default 'sm'
}
export function VerdictBadge(props: VerdictBadgeProps);
```

| Verdict | `Badge` variant | Plain-language description |
|---|---|---|
| `OPTIMAL` | `success` | proven best combination |
| `FEASIBLE` | `info` | a valid combination, not proven best |
| `UNSAT` | `error` | no combination satisfies the rules |
| `TIMEOUT` | `warning` | stopped at the time budget |
| `INCOMPATIBLE` | `default` | the engine cannot solve this problem |
| any other | `default` | none; the value itself is the text |

Markup: an outer `<div class="rendering-verdict">` (a block element, so the reasons `<ul>` is never inside a `<span>`)
holding an inline wrapper `<span>` with the `Badge` and, for a known verdict, an `.sr-only` `<span>` whose text is
`, {description}` right after it. The wrapper's text is therefore `OPTIMAL, proven best combination`: assistive
technology reads the description in the flow, after the verdict and separated by a comma, and no `aria-describedby`
is used (on a generic `<span>` with no role it may not be announced). An unknown verdict has no `.sr-only` element; its
wrapper's text is the value only. `reasons`, when non-empty, render as `<ul aria-label="Reasons">` after the wrapper in
the given order.

```ts
// MetricCards.tsx
export interface Metric {
  id?: string;               // React key; `${label}-${index}` otherwise
  label: string;
  value: number | string | null;
  unit?: string;                   // not shown when the value is null
  trend?: { direction: 'up' | 'down' | 'flat'; label: string };
  hint?: string;                   // a short explanation under the value
}
interface MetricCardsProps {
  metrics: Metric[];
  label?: string;            // accessible name of the list, default 'Key figures'
}
export function MetricCards(props: MetricCardsProps);
```

Markup: `null` (nothing) for an empty `metrics`. Otherwise `<ul aria-label={label}>` with one `<li>` per metric
holding a `<dl>`: `<dt>{label}</dt>` and `<dd>` with the value and, for a non-null value, ` {unit}`. Numbers go
through `new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })`; strings are shown as they are; `null` is an
`aria-hidden` `—` plus an `.sr-only` `no value`. A trend is a `<p>` with an `aria-hidden` arrow (`↑`, `↓`, `→`) and its
`label` as text; a hint is a `<small>`. The direction never carries meaning alone: the trend `label` says it. The key of
each `<li>` is `id`, or the label plus the position when `id` is missing, so metrics with the same label render without
a duplicate-key warning.

## 3. Shared rules

- Every interactive control has a visible label or an accessible name (constitution 11.2).
- Severity and verdict are always written as words; colour only reinforces them.
- No component fetches data; all are pure renderers of their props.
- No component stylesheet holds a hex colour (each component test reads its CSS file).

## 4. Hygiene test and allow-list

`rawRenderingAllowList.ts` exports:

```ts
export type RawRenderingLine = { line: number; text: string };
export type RawRenderingOffender = {
  offender: number;          // number in ROADMAP.md, "Raw-rendering offenders at 912648c"
  file: string;              // path under frontend/src, e.g. 'pages/Jobs/JobResult.tsx'
  lines: RawRenderingLine[];
  reason: string;
  retiredBy: 'M2.3' | 'M2.4' | 'M2.5' | 'M2.6';
};
export type UnlistedFinding = Omit<RawRenderingOffender, 'retiredBy'> & { retiredBy: null };
export const MAX_ALLOWED_OFFENDERS = 15;   // a reviewer lowers it as entries go
export const UNLISTED_REASON: string;
export const RAW_RENDERING_ALLOW_LIST: RawRenderingOffender[];   // offenders 1–15, one entry each
export const UNLISTED_FINDINGS: UnlistedFinding[];
```

- `text` is the trimmed text of the line; `line` is its current line number. One offender can have several lines
  (offender 1 has three).
- Offender 5 (`pages/Reports/RepDetail.tsx`) lists only line 326. ROADMAP also names :77 and :329, which the detector
  does not flag: `sourceText` (:77) is shown in the textarea at :317 through a variable the detector does not see, and
  :329 is a copy handler. The entry's `reason` says so; both go with the screen in M2.4.
- `UNLISTED_FINDINGS` holds two detector findings that ROADMAP M2 does not list, numbered 16 and 17 with `reason`
  `UNLISTED_REASON` and `retiredBy: null`, for the coordinator to classify:
  16. `pages/Workbench/SourcePanel.tsx:108` — the diff `<pre className="wb-diff" …>`;
  17. `pages/Analysis/SavedDecision.tsx:34` — a reference stringified as the fallback text of a `<dd>`.
- Sources: `import.meta.glob` of `/src/**/*.{ts,tsx}` without `*.test.*` and `src/test/**`, and without files named
  `testKit`/`testUtils`. Paths are reduced to the part under `src/`. The exempt files are exactly
  `components/rendering/SourceView.tsx` and `components/rendering/LogPanel.tsx`.
- Detector (`findRawRendering`, exported from the test file), line by line, after skipping comment lines (a trimmed
  line that starts with `//`, `/*` or `*`, or that is exactly one JSX comment `{/* … */}`; a line with code between
  two JSX comments is read) and blanking single- and double-quoted string literals:
  - a line with `<pre` not followed by a word character or `-` is a `pre` finding (whatever feeds it); a line with a
    `<pre` tag yields one finding, even when it also renders a `JSON.stringify`;
  - otherwise a `JSON.stringify(` is a `stringify` finding when it is rendered, that is when the innermost `{` still
    open before the call:
    - is a JSX child expression after a tag, JSX text or a sibling expression (`<p>Value: {`, `<dd>{a} {`), whatever
      precedes the call inside it (`{typeof v === 'string' ? v : JSON.stringify(v)}`,
      `{items.map((i) => JSON.stringify(i))}`);
    - is a child expression alone on its line (the usual layout of a multi-line element), such as
      `{x && JSON.stringify(x)}`, unless it reads as an object literal member (`{ a: …`, `{ ...…`);
    - is a JSX attribute value that is the call itself (`value={JSON.stringify(`);
    - is the `${` of a template literal that is itself the whole of a rendered child expression
      (``<p>{`Value: ${JSON.stringify(x)}`}</p>``).
  - Not rendered: an arrow body block, an object literal or call argument (`(`, `,`, `=`, `?`, `[`, `&`, `|` before
    the brace), a handler or wrapped attribute value, and a template literal in a non-rendered position (a request body,
    a `key`).
- Known limits, each pinned by a test named `known limit: …` that asserts the miss, so a detector change that closes
  one shows up as a failing test to update:
  1. an apostrophe in JSX text is read as a string quote and blanks what follows, so
     ``<p>don't {JSON.stringify(x)} isn't</p>`` is not reported;
  2. a template literal that is only part of a larger child expression is not seen
     (``<p>{label + `: ${JSON.stringify(x)}`}</p>``);
  3. a `JSON.stringify` on a different line from the `{` that opened its expression is not seen
     (`<p>{` / `JSON.stringify(x)` / `}</p>`);
  4. a call wrapped inside an attribute value is not seen (`<Field title={x ?? JSON.stringify(y)} />`);
  5. a `<pre` inside a string literal is not reported (`const tag = "<pre>";`), by design of the string blanking;
  6. a line with a `<pre` tag and a rendered `JSON.stringify` counts as one `pre` finding.
  Not pinned by a test: raw rendering built without the literal `<pre` or `JSON.stringify(` (`React.createElement('pre')`,
  `white-space: pre`, a variable computed elsewhere, as in offender 5's :77) is not seen.
- Matching is a multiset per (file, trimmed text): every finding takes one accepted line with the same file and text
  from either array, and every accepted line takes one finding. So a second identical raw line in a listed file is
  unlisted, and when one of two identical listed lines is removed, the extra entry line is stale.
- Three pure functions of the test file, exported and tested with synthetic sources and allow-lists, and then run on
  the application sources with `RAW_RENDERING_ALLOW_LIST` plus `UNLISTED_FINDINGS`, where each must return an empty
  list:
  - (a) `unlistedFindings(sources, allow)`: findings not covered
    (`<file>:<line>  <text>  — render with the catalogue (SourceView, LogPanel, ...) instead of adding an entry to rawRenderingAllowList.ts`);
  - (b) `staleEntries(sources, allow)`: accepted lines that no finding backs
    (`<file>:<line>  <text>  — no longer raw rendering: remove this entry from rawRenderingAllowList.ts`);
  - (c) `wrongLineNumbers(sources, allow)`: accepted lines where the line at `line` of the file, trimmed, differs from
    `text` (`<file>:<line> is "<actual>", expected "<text>"`, `is undefined` past the end of the file).
  So a line moved by an edit needs its `line` updated, but it never turns into an unlisted or stale finding.
- Allow-list shape: `MAX_ALLOWED_OFFENDERS` is 15; the list has at most that many entries; the offender numbers, in
  order, are exactly 1–15; each entry has at least one line and a reason; `retiredBy` is `M2.3` for 1–4, `M2.4` for
  5, 7 and 11, `M2.5` for 8–10 and 12–15 and `M2.6` for 6. Every unlisted finding has `UNLISTED_REASON`,
  `retiredBy: null` and a file that no offender entry names. The test does not compare entry files with ROADMAP.
- The slice that removes the first offender lowers `MAX_ALLOWED_OFFENDERS` and relaxes "exactly 1–15" to "a subset of
  1–15".
- Controls: the detector is called on in-memory samples (`<pre>` hits, rendered-stringify hits including a child alone
  on its line and a rendered template literal, non-rendered and comment misses, the known limits, line numbering), the
  exemption on in-memory paths, the three checks on synthetic inputs (new finding, stale entry, moved line, line past
  the end, duplicates both ways, another file), and the scan checks it read more than 100 files and none under
  `src/test/`, so the test proves it can fail.

## 5. Documentation

`docs/qa/RENDERING_CATALOGUE.md` (S4) documents the five components: what each shows, its props (§2), when to use it,
the two exemptions of the hygiene rule, the detector's known limits (§4) and how to remove an allow-list entry. ARCHITECTURE §5.3 stays the
catalogue table and is owned by the coordinator; no other design-system document exists in scope, so `docs/qa/` holds
this page until one does.

## 6. Requirements and the slice that delivers each

| Requirement | Slice |
|---|---|
| `frontend-rendering-source-view` | S1 |
| `frontend-rendering-log-panel` | S1 |
| `frontend-rendering-diagnostics-list` | S2 |
| `frontend-rendering-verdict-badge` | S2 |
| `frontend-rendering-metric-cards` | S2 |
| `frontend-rendering-raw-hygiene` | S3 |

Every component test carries `[utest->req~frontend-rendering-<name>~1]` and every component `[impl->…]`; the hygiene
test file carries `[utest->req~frontend-rendering-raw-hygiene~1]` once.

## 7. Risks

- The detector is a line-based text scan with the known limits of §4. Accepted for M2.2; ui-qa screenshots (G12) catch
  the rest.
- `UNLISTED_FINDINGS` can be grown by editing one file; only its reason and `retiredBy` are tested, so its shrink rule
  is enforced by review.
- Accessibility is checked by roles, names and text, not by a WCAG scan (constitution 11 GAP), and not with a real
  screen reader: the verdict description is in-flow hidden text, which is read with the verdict, but no test runs an
  assistive technology.
- The 24 px minimum target of constitution 11.2 is set by CSS on the Copy and Download buttons and not asserted by a
  test (jsdom has no layout). Whether it applies on desktop is for the coordinator to confirm (tasks.md follow-ups).
- `VerdictBadge` knows `OPTIMAL`, `FEASIBLE`, `UNSAT`, `TIMEOUT` and `INCOMPATIBLE`; the API `Termination` type
  (`frontend/src/api/client.ts`) is `OPTIMAL | FEASIBLE | INFEASIBLE | UNKNOWN`, so `INFEASIBLE` and `UNKNOWN` render
  as neutral `default` badges without description until M2.3 maps them.
- The jsdom environment has no real clipboard or download: tests stub `navigator.clipboard.writeText`,
  `URL.createObjectURL`, `URL.revokeObjectURL` and `HTMLAnchorElement.prototype.click`, and fake `setTimeout` to see the
  deferred revoke.

## 8. Deviations

- One PR carries M2.1 and M2.2 together, over the ~300-line guideline (constitution 14.1), because the owner scoped
  this change to both. The slices of tasks.md keep the review in parts.
- Tests were written in the same tasks as the components, but no red_before (G3) run exists: the registered check
  cannot accept import errors of not-yet-existing modules as a red result.
- G1 (`openspec validate m21-rendering-catalogue --strict`) is not run: owner exemption until M0.3 (PR 37) puts the
  OpenSpec CLI in CI.

- Review round 1 of PR 38 led to fixes merged on the change branch: shared `saveText` with a deferred revoke,
  `1 of 1 line`, 24 px buttons, the `MetricCards` key, pointer grouping in `DiagnosticsList`, in-flow hidden text in
  `VerdictBadge` (no `aria-describedby`, outer `<div>`), and the hygiene detector and matching of §4 (child alone on
  its line, rendered template literal, JSX comment lines, multiset matching, exported pure checks, known-limit tests).

## 9. Rollback

All files are new and no screen imports them in this change; reverting the PR removes them. The hygiene test can be
reverted alone without affecting the components.
