# Design: m21-rendering-catalogue

Status: proposed; nothing is built. Fixed inputs: ROADMAP M2.1 and M2.2 with its list of 15 offenders at 912648c,
ARCHITECTURE §5.3 (catalogue) and §5.4 (identifiers), ADR-0014, constitution Articles 1, 11 and 15. This file holds
the component contracts that the implementers, the test-designer and the reviewers share.

## 1. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Where the components live | flat files under `frontend/src/components/rendering/` (`SourceView.tsx`, `SourceView.css`, `SourceView.test.tsx`, …), imported by path, with no `index.ts`, like `components/ui` | `shared/ui` of ARCHITECTURE §5.1: that layout does not exist yet; the folder moves with `components/ui` when it lands. A barrel `index.ts`: `components/ui` has none, and a barrel would hide which file the hygiene exemption names |
| Building blocks | reuse `components/ui` `Badge` (verdicts, severities), `Action` (Copy and Download buttons), `useCopy` (clipboard and its `copied`/`failed` status) and `EmptyState` (`No log`, `No diagnostics`); the `.sr-only` class and the tokens of `styles/globals.css` (`--font-mono`, `--color-*`, severity colours) | new buttons or colours: the existing hygiene test already forbids hex colours outside `globals.css` |
| Dependencies | none added; `frontend/package.json` and the lockfile are outside this change | `axe-core`/`vitest-axe` for an automated scan, `@testing-library/user-event` for typing: both are new dependencies (constitution 11 keeps the axe scan a GAP) |
| Accessibility tests | Testing Library queries by role and accessible name (`getByRole('region', { name })`, `getByRole('button', { name: 'Copy Manifest' })`, `getByRole('status')`, `getByRole('searchbox' or 'textbox', { name: 'Search the log' })`, `getByRole('list', { name })`, `getByRole('heading', { level })`), `toHaveAccessibleDescription` from `@testing-library/jest-dom`, `fireEvent` for input, and a tab-order check (`tabIndex` 0) for the code block | an automated WCAG scan (new dependency) |
| Hygiene test | a new file `frontend/src/test/rawRenderingHygiene.test.ts` with its data in `frontend/src/test/rawRenderingAllowList.ts` | extending `frontend/src/hygiene.test.ts` (named by ADR-0014 and constitution 15 as "to extend"): that file is about theme and persona, and a separate data file keeps the shrinking list reviewable on its own. The constitution's `Enforced:` line is updated by the owner when the rule lands |
| Download | a `Blob` of the shown text, an object URL and a temporary `<a download={filename}>`, revoked after the click | a server endpoint: exports already exist where they are needed, and the components must work offline |
| Text | English, in the components (constitution 12) | an i18n layer: none exists |

## 2. Component contracts

All are named exports of their own file under `frontend/src/components/rendering/`.

```ts
// SourceView.tsx
export interface SourceViewProps {
  source: string | object;   // an object is shown as JSON.stringify(source, null, 2)
  label: string;             // names the region and the buttons
  language?: string;         // informative only: data-language on <code>; no highlighting in M2.1
  filename?: string;         // Download is offered only when this is given
  maxHeight?: string;        // CSS length for the scrolling code block, e.g. '24rem'
}
export function SourceView(props: SourceViewProps): JSX.Element;
```

Markup: `<section role="region" aria-label={label}>` containing `<pre tabIndex={0}><code>{text}</code></pre>`, the
button `Copy {label}` (`Action`, via `useCopy`, key `source`), the button `Download {label}` only if `filename`, and a
`role="status"` live region that says `Copied` or `Copy failed` from `useCopy().status('source')` and is empty when idle.

```ts
// LogPanel.tsx
export interface LogPanelProps {
  log: string;
  title?: string;            // default 'Log'
  filename?: string;         // Download only when given
  defaultOpen?: boolean;     // default false
}
export function LogPanel(props: LogPanelProps): JSX.Element;
```

Markup: `<details open={defaultOpen}>` with `<summary>{title} ({n} lines)</summary>` (`1 line` in the singular; `n`
counts the lines of `log` split on `\n`, without a trailing empty line; `0 lines` for an empty log); inside, an input
`type="search"` labelled `Search the log`, a `role="status"` region with `{shown} of {n} lines`, the buttons
`Copy {title}` and, with `filename`, `Download {title}`, then `<pre tabIndex={0}>` with the matching lines. The filter is
a case-insensitive substring match on each line; Copy and Download always use the whole log. An empty log shows
`EmptyState` with the title `No log` instead of the search box and the `<pre>`.

```ts
// DiagnosticsList.tsx
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  resource?: string;         // grouping key; missing → the group 'General'
  pointer?: string;          // e.g. a JSON pointer '/tasks/2'
  hint?: string;
}
export interface DiagnosticsListProps {
  diagnostics: Diagnostic[];
  headingLevel?: 2 | 3 | 4 | 5;   // level of the group headings, default 3
}
export function DiagnosticsList(props: DiagnosticsListProps): JSX.Element;
```

Markup: a summary line (`2 errors, 1 warning`; zero counts are left out; singular for one), then per resource, in
order of first appearance with `General` last, a heading at `headingLevel` and a `<ul>`; items sorted error, warning,
info (stable within a severity). Each item: a `Badge` with the word `Error`, `Warning` or `Info` (variants `error`,
`warning`, `info`), the code in `--font-mono`, the message, the pointer when given and the hint when given. An empty
list shows `EmptyState` with the title `No diagnostics`.

```ts
// VerdictBadge.tsx
export type Verdict = 'OPTIMAL' | 'FEASIBLE' | 'UNSAT' | 'TIMEOUT' | 'INCOMPATIBLE';
export interface VerdictBadgeProps {
  verdict: Verdict | (string & {});
  reasons?: string[];
  size?: 'sm' | 'md';        // passed to Badge, default 'sm'
}
export function VerdictBadge(props: VerdictBadgeProps): JSX.Element;
```

| Verdict | `Badge` variant | Accessible description |
|---|---|---|
| `OPTIMAL` | `success` | A binding was found and proven best for the objective |
| `FEASIBLE` | `info` | A binding satisfies the hard constraints but is not proven best |
| `UNSAT` | `error` | No binding satisfies the hard constraints |
| `TIMEOUT` | `warning` | The engine reached its time budget before a verdict |
| `INCOMPATIBLE` | `warning` | The engine does not support every feature of this problem |
| any other | `default` | none; the value itself is the text |

The description is a `.sr-only` element referenced by `aria-describedby` on the badge wrapper (an id from
`useId`), and also its `title`. `reasons`, when non-empty, render as a `<ul>` after the badge in the given order.

```ts
// MetricCards.tsx
export interface Metric {
  id?: string;               // React key; the label is the key otherwise
  label: string;
  value: number | string | null;   // null → '—'
  unit?: string;                   // not shown when the value is null
  trend?: { direction: 'up' | 'down' | 'flat'; label: string };
  hint?: string;                   // a short explanation under the value
}
export interface MetricCardsProps {
  metrics: Metric[];
  label?: string;            // accessible name of the list, default 'Metrics'
}
export function MetricCards(props: MetricCardsProps): JSX.Element;
```

Markup: `<ul aria-label={label}>` with one `<li>` per metric: label, value (numbers through
`new Intl.NumberFormat('en')`, strings as they are, `null` as `—`), unit, trend as text with a decorative arrow
(`aria-hidden`), hint. The direction never carries meaning alone: the trend `label` says it.

## 3. Shared rules

- Every interactive control has a visible label or an accessible name and a target of at least 24 px (constitution
  11.2; `Action` size `sm` is 32 px).
- Severity and verdict are always written as words; colour only reinforces them.
- No component fetches data; all are pure renderers of their props.

## 4. Hygiene test and allow-list

`rawRenderingAllowList.ts` exports:

```ts
export interface AllowListEntry { offender: number; file: string; text: string; note?: string }
export const RAW_RENDERING_ALLOW_LIST: readonly AllowListEntry[];   // the 15 offenders of ROADMAP M2
export const UNLISTED_FINDINGS: readonly Omit<AllowListEntry, 'offender'>[];   // detector hits beyond the 15
```

- `file` is the path from the repository root as ROADMAP M2 writes it (`frontend/src/pages/Jobs/JobResult.tsx`);
  `text` is the trimmed text of the matching line. One offender can have several entries (offender 1 has three lines).
- The detector reads the shipped `.tsx` sources (the `import.meta.glob` pattern of `hygiene.test.ts`, test files and
  test kits excluded) and reports every line that contains `<pre` followed by a space, `>` or the end of the line, or
  `JSON.stringify(`. Only `.tsx` files render JSX, so `.ts` files are not scanned. The two exempt files are
  `frontend/src/components/rendering/SourceView.tsx` and `frontend/src/components/rendering/LogPanel.tsx`.
- Matching is by file plus trimmed line text, not by line number, so unrelated edits that move a line do not break
  the test. A hit matches when an entry of either array has the same file and text.
- The test fails when (a) a hit matches no entry, (b) an entry matches no line of its file (stale: remove it), or (c)
  an entry of `RAW_RENDERING_ALLOW_LIST` names a file that is not one of the 15 offender files or an offender number
  outside 1–15. In this change the offender numbers present are exactly 1–15; later slices remove entries and the
  "exactly 1–15" assertion becomes "a subset of 1–15" in the slice that removes the first offender.
- Detector hits found while writing the list that are not among the 15 (for example a `JSON.stringify` used as a key
  or a non-rendering use in a `.tsx` file, or a raw rendering the audit at 912648c missed) go into `UNLISTED_FINDINGS`
  with a `note`, never into the offender list, and the implementer reports each one in the result block for the
  coordinator to classify. ROADMAP line numbers are at 912648c and are only a guide; the entry texts are taken from
  the current files.
- Failure messages name the file, the trimmed text and which of (a), (b) or (c) applies.
- Controls: the detector is a pure function defined in the test file and is called on in-memory
  samples (a hit with `<pre className=…>`, a hit with `JSON.stringify(value, null, 2)`, a miss), so the test proves it
  can fail.

## 5. Documentation

`docs/qa/RENDERING_CATALOGUE.md` documents the five components: what each shows, its props (§2), when to use it,
the two exemptions of the hygiene rule and how to remove an allow-list entry. ARCHITECTURE §5.3 stays the catalogue
table and is owned by the coordinator; no other design-system document exists in scope, so `docs/qa/` holds this page
until one does.

## 6. Requirements and the slice that delivers each

| Requirement | Slice |
|---|---|
| `frontend-rendering-source-view` | S1 |
| `frontend-rendering-log-panel` | S1 |
| `frontend-rendering-diagnostics-list` | S2 |
| `frontend-rendering-verdict-badge` | S2 |
| `frontend-rendering-metric-cards` | S2 |
| `frontend-rendering-raw-hygiene` | S3 |

Every test carries `[utest->req~frontend-rendering-<name>~1]`; every component carries `[impl->…]`.

## 7. Risks

- A text scan misses raw rendering built without the literal `<pre` or `JSON.stringify(` (for example
  `React.createElement('pre')` or `whiteSpace: 'pre'` styling). Accepted for M2.2; ui-qa screenshots (G12) catch the
  rest.
- `UNLISTED_FINDINGS` can be grown by editing one file; the shrink rule for it is enforced by review, not by the test.
- Accessibility is checked by roles, names and descriptions, not by a WCAG scan (constitution 11 GAP).
- The jsdom environment has no real clipboard or download: tests stub `navigator.clipboard.writeText` and
  `URL.createObjectURL`.

## 8. Deviations

- One PR carries M2.1 and M2.2 together, over the ~300-line guideline (constitution 14.1), because the owner scoped
  this change to both. The slices of tasks.md keep the review in parts.
- Tests are written before the components in the same tasks, but no red_before (G3) run exists: the registered check
  cannot accept import errors of not-yet-existing modules as a red result.
- G1 (`openspec validate m21-rendering-catalogue --strict`) is not run: owner exemption until M0.3 (PR 37) puts the
  OpenSpec CLI in CI.

## 9. Rollback

All files are new and no screen imports them in this change; reverting the PR removes them. The hygiene test can be
reverted alone without affecting the components.
