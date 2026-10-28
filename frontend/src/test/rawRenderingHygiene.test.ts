import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_OFFENDERS,
  RAW_RENDERING_ALLOW_LIST,
  UNLISTED_FINDINGS,
  UNLISTED_REASON,
} from './rawRenderingAllowList';

// Render, never dump (constitution Article 15, ADR 0014): outside the two catalogue components no screen puts a `<pre>` or a stringified
// object on screen. The detector is line based and deliberately simple:
//   (a) a line with a `<pre` JSX tag is a finding (the `<pre>` line itself, whatever feeds it);
//   (b) a `JSON.stringify(` is a finding when it is RENDERED: the innermost `{` still open at the call is a JSX child expression
//       (`>{ ... JSON.stringify(`) or a JSX attribute value that is the call itself (`value={JSON.stringify(`).
//   Anything else is not rendered: request bodies, storage, Blob/download/copy calls, comparisons, keys, template literals not rendered as a whole child, helpers.
// Comment lines are skipped. The remaining limits are pinned by the tests named 'known limit: ...'.

const EXEMPT_FILES = ['components/rendering/SourceView.tsx', 'components/rendering/LogPanel.tsx'];

export type Finding = { line: number; text: string; kind: 'pre' | 'stringify' };

const withoutStrings = (code: string) => code.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");

/** True when the innermost `{` still open in `prefix` renders a value: a JSX child expression or a bare attribute value. */
function opensRenderedExpression(prefix: string): boolean {
  const stack: number[] = [];
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === '{') stack.push(i);
    else if (prefix[i] === '}') stack.pop();
  }
  return innermostRenders(prefix, stack);
}

function innermostRenders(prefix: string, stack: number[]): boolean {
  const open = stack.pop();
  if (open === undefined) return false;
  const head = prefix.slice(0, open);
  const before = head.trimEnd();
  const inside = prefix.slice(open + 1);
  // An attribute value is rendered only when it is the call itself (`value={JSON.stringify(`), not a handler or a wrapped call.
  if (/[\w-]=$/.test(head)) return inside.trim() === '';
  // A template literal `${`: rendered only when the template is itself the whole enclosing child expression (`{`Value: ${`).
  if (before.endsWith('$')) {
    const outer = stack[stack.length - 1];
    if (outer === undefined || !/^\s*`[^`]*$/.test(prefix.slice(outer + 1, open - 1))) return false;
    return innermostRenders(prefix, stack);
  }
  // Not a child: an arrow body block.
  if (before.endsWith('=>')) return false;
  // A child expression on its own line (the usual layout of a multi-line element), unless it reads as an object literal member.
  if (before === '') return !/^\s*([\w$]+\s*:|\.\.\.)/.test(inside);
  // JS punctuation before the brace means an object literal or a block, not JSX.
  if (/[(,=?[&|]$/.test(before)) return false;
  // Otherwise a child: after a tag, a sibling expression or JSX text (`<p>Value: {`).
  return /<[A-Za-z>]/.test(before);
}

export function findRawRendering(text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (/^(\/\/|\/\*|\*|\{\/\*(?:(?!\*\/).)*\*\/\}$)/.test(line)) return;
    const code = withoutStrings(raw);
    const at = { line: index + 1, text: line };
    if (/<pre(?![\w-])/.test(code)) {
      findings.push({ ...at, kind: 'pre' });
      return;
    }
    for (let from = code.indexOf('JSON.stringify('); from !== -1; from = code.indexOf('JSON.stringify(', from + 1)) {
      if (opensRenderedExpression(code.slice(0, from))) {
        findings.push({ ...at, kind: 'stringify' });
        return;
      }
    }
  });
  return findings;
}

const isExempt = (file: string) => EXEMPT_FILES.includes(file);

/** Findings of the sources, as { file (under src), line, text }. src/test/** and the test kits are not application code. */
function scan(sources: Record<string, string>) {
  return Object.entries(sources)
    .map(([path, text]) => [path.replace(/^\/src\//, ''), text] as const)
    .filter(([file]) => !isExempt(file))
    .flatMap(([file, text]) => findRawRendering(text).map((finding) => ({ file, ...finding })));
}

const files = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.*', '!/src/test/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const sources = Object.fromEntries(Object.entries(files).filter(([path]) => !/([Tt]estKit\.tsx?$|[Tt]estUtils\.tsx?$)/.test(path)));

type Accepted = { file: string; lines: { line: number; text: string }[] }[];

const accepted: Accepted = [...RAW_RENDERING_ALLOW_LIST, ...UNLISTED_FINDINGS];
const key = (file: string, text: string) => `${file}\u0000${text}`;

/** How many times each (file, text) occurs: findings and accepted lines are matched as multisets. */
function counts(keys: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const k of keys) map.set(k, (map.get(k) ?? 0) + 1);
  return map;
}

/** Takes one occurrence of `k` from `left`; false when none remains. */
function take(left: Map<string, number>, k: string): boolean {
  const n = left.get(k) ?? 0;
  if (n === 0) return false;
  left.set(k, n - 1);
  return true;
}

/** Raw findings that no accepted line covers (a new one, or one more copy of a listed line). */
export function unlistedFindings(sources: Record<string, string>, allow: Accepted): string[] {
  const left = counts(allow.flatMap((entry) => entry.lines.map((l) => key(entry.file, l.text))));
  return scan(sources)
    .filter(({ file, text }) => !take(left, key(file, text)))
    .map(({ file, line, text }) => `${file}:${line}  ${text}  — render with the catalogue (SourceView, LogPanel, ...) instead of adding an entry to rawRenderingAllowList.ts`);
}

/** Accepted lines that no finding backs any more (fixed, or one copy removed). */
export function staleEntries(sources: Record<string, string>, allow: Accepted): string[] {
  const left = counts(scan(sources).map(({ file, text }) => key(file, text)));
  return allow.flatMap((entry) => entry.lines
    .filter((l) => !take(left, key(entry.file, l.text)))
    .map((l) => `${entry.file}:${l.line}  ${l.text}  — no longer raw rendering: remove this entry from rawRenderingAllowList.ts`));
}

/** Accepted lines whose number no longer points at their text. */
export function wrongLineNumbers(sources: Record<string, string>, allow: Accepted): string[] {
  return allow.flatMap((entry) => entry.lines.flatMap((l) => {
    const actual = sources[`/src/${entry.file}`]?.split('\n')[l.line - 1]?.trim();
    return actual === l.text ? [] : [`${entry.file}:${l.line} is ${JSON.stringify(actual)}, expected ${JSON.stringify(l.text)}`];
  }));
}

// [impl->req~frontend-retire-allow-list-ceiling~1]
/** A message when the ceiling is not the number of entries, otherwise nothing. */
export function ceilingMismatch(max: number, entries: readonly unknown[]): string | undefined {
  return max === entries.length ? undefined : `MAX_ALLOWED_OFFENDERS is ${max} but the allow-list has ${entries.length} entries`;
}

describe('the detector of raw rendering', () => {
  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a <pre> tag', () => {
    expect(findRawRendering('<pre>{text}</pre>')).toHaveLength(1);
    expect(findRawRendering('  <pre className="x" aria-label="Log">')).toHaveLength(1);
    expect(findRawRendering('<pre tabIndex={0}><code>{source}</code></pre>')[0]?.kind).toBe('pre');
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a stringify rendered as a JSX child', () => {
    expect(findRawRendering('<code>{JSON.stringify(option.rest)}</code>')).toHaveLength(1);
    expect(findRawRendering("<dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>")).toHaveLength(1);
    expect(findRawRendering('<dd>{ok ? <>{a} <small>{b}</small></> : JSON.stringify(ref)}</dd>')).toHaveLength(1);
    expect(findRawRendering('  {JSON.stringify(x)}')).toHaveLength(1);
    expect(findRawRendering('<p>Value: {JSON.stringify(x)}</p>')).toHaveLength(1);
    expect(findRawRendering('<dd>{a} {JSON.stringify(b)}</dd>')).toHaveLength(1);
    expect(findRawRendering('<ul>{items.map((i) => JSON.stringify(i))}</ul>')).toHaveLength(1);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a child expression alone on its line', () => {
    expect(findRawRendering("  {typeof v === 'string' ? v : JSON.stringify(v)}")).toHaveLength(1);
    expect(findRawRendering('  {items.map((i) => JSON.stringify(i))}')).toHaveLength(1);
    expect(findRawRendering('  {x && JSON.stringify(x)}')).toHaveLength(1);
    expect(findRawRendering('  { a: JSON.stringify(x) }')).toEqual([]);
    expect(findRawRendering('  { ...JSON.stringify(x) }')).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a stringify inside a template literal rendered as a child', () => {
    expect(findRawRendering('<p>{`Value: ${JSON.stringify(x)}`}</p>')).toHaveLength(1);
    expect(findRawRendering('const init = { body: `${JSON.stringify(x)}` };')).toEqual([]);
    expect(findRawRendering('<Row key={`${JSON.stringify(a)}`} />')).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('skips a JSX comment line', () => {
    expect(findRawRendering('{/* <pre>{JSON.stringify(x)}</pre> */}')).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('known limit: an apostrophe in JSX text hides a later finding on the same line', () => {
    expect(findRawRendering("<p>don't {JSON.stringify(x)} isn't</p>")).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('known limit: a stringify on a different line from the brace that opened its expression is not seen', () => {
    expect(findRawRendering('<p>{\n  JSON.stringify(x)\n}</p>')).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('known limit: a template literal that is only part of a child expression is not seen', () => {
    expect(findRawRendering('<p>{label + `: ${JSON.stringify(x)}`}</p>')).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('skips a line made of JSX comments only, not one with code between them', () => {
    expect(findRawRendering('{/* a */}<pre>{x}</pre>{/* b */}')).toHaveLength(1);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('known limit: a stringify wrapped inside an attribute value is not seen', () => {
    expect(findRawRendering('<Field title={x ?? JSON.stringify(y)} />')).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('known limit: a <pre inside a string literal is not reported', () => {
    expect(findRawRendering('const tag = "<pre>";')).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('known limit: a line with a <pre tag and a rendered stringify yields one finding', () => {
    expect(findRawRendering('<pre>{JSON.stringify(x)}</pre>')).toEqual([{ line: 1, text: '<pre>{JSON.stringify(x)}</pre>', kind: 'pre' }]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a stringify given as a JSX attribute value', () => {
    expect(findRawRendering('<CodeEditor value={JSON.stringify(doc, null, 2)} readOnly />')).toHaveLength(1);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('does not report stringify that is not rendered', () => {
    const quiet = [
      "const r = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });",
      "localStorage.setItem(KEY, JSON.stringify({ a: 1 }));",
      "const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));",
      "saveBytes(new TextEncoder().encode(JSON.stringify(body, null, 2)).buffer as ArrayBuffer, 'a.json', 'application/json');",
      "<Action onClick={() => void copy(JSON.stringify(report.document, null, 2), 'json')}>Copy</Action>",
      'const dirty = JSON.stringify(current) !== JSON.stringify(working);',
      '<Row key={`${plan}:${JSON.stringify(addOns)}`} />',
      'const stamp = (value) => JSON.stringify(value ?? null);',
      'const source = useMemo(() => JSON.stringify(value, null, 2) ?? \'\', [value]);',
      "return [...new Map(points.map(p => [JSON.stringify(p), p])).values()];",
      '<button onClick={() => { save(JSON.stringify(x)); }}>Save</button>',
      '// <pre>{JSON.stringify(x)}</pre>',
      '<preview>{x}</preview>',
    ];
    for (const sample of quiet) expect(findRawRendering(sample), sample).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('numbers lines from 1 and keeps the trimmed text', () => {
    expect(findRawRendering('const a = 1;\n    <pre>{a}</pre>')).toEqual([{ line: 2, text: '<pre>{a}</pre>', kind: 'pre' }]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('exempts the catalogue files by exact path and nothing else', () => {
    const sample = '<pre>{JSON.stringify(x)}</pre>';
    const hits = (file: string) => scan({ [`/src/${file}`]: sample }).length;
    for (const file of EXEMPT_FILES) expect(hits(file), file).toBe(0);
    expect(hits('components/rendering/SourceViewer.tsx')).toBe(1);
    expect(hits('pages/components/rendering/SourceView.tsx')).toBe(1);
    expect(hits('pages/Jobs/JobResult.tsx')).toBe(1);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('exempts exactly the two catalogue components', () => {
    expect(EXEMPT_FILES).toEqual(['components/rendering/SourceView.tsx', 'components/rendering/LogPanel.tsx']);
    for (const file of EXEMPT_FILES) expect(files[`/src/${file}`], file).toBeDefined();
  });
});

describe('raw rendering in the application sources', () => {
  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reads the sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(Object.keys(sources).some((path) => path.startsWith('/src/test/'))).toBe(false);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('has no raw rendering outside the allow-list', () => {
    expect(unlistedFindings(sources, accepted)).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('has no stale allow-list entry: the list may only shrink', () => {
    expect(staleEntries(sources, accepted)).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('keeps the line numbers of the allow-list correct', () => {
    expect(wrongLineNumbers(sources, accepted)).toEqual([]);
  });
});

describe('the allow-list checks', () => {
  const dump = '<pre>{a}</pre>';
  const at = (file: string, ...lines: string[]) => ({ [`/src/${file}`]: lines.join('\n') });
  const allow = (file: string, ...lines: { line: number; text: string }[]): Accepted => [{ file, lines }];

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a new raw finding in an unlisted file, with file:line, text and the instruction', () => {
    const found = unlistedFindings(at('pages/New.tsx', 'const a = 1;', dump), []);
    expect(found).toEqual([`pages/New.tsx:2  ${dump}  — render with the catalogue (SourceView, LogPanel, ...) instead of adding an entry to rawRenderingAllowList.ts`]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports an entry whose line no longer exists as stale, with file:line, text and the instruction', () => {
    const stale = staleEntries(at('pages/Old.tsx', 'const a = 1;'), allow('pages/Old.tsx', { line: 3, text: dump }));
    expect(stale).toEqual([`pages/Old.tsx:3  ${dump}  — no longer raw rendering: remove this entry from rawRenderingAllowList.ts`]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('accepts a listed finding and reports nothing', () => {
    const sources = at('pages/Ok.tsx', dump);
    const list = allow('pages/Ok.tsx', { line: 1, text: dump });
    expect([unlistedFindings(sources, list), staleEntries(sources, list), wrongLineNumbers(sources, list)]).toEqual([[], [], []]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a moved line only as a wrong line number', () => {
    const sources = at('pages/Moved.tsx', 'const a = 1;', dump);
    const list = allow('pages/Moved.tsx', { line: 1, text: dump });
    expect(unlistedFindings(sources, list)).toEqual([]);
    expect(staleEntries(sources, list)).toEqual([]);
    expect(wrongLineNumbers(sources, list)).toEqual([`pages/Moved.tsx:1 is "const a = 1;", expected ${JSON.stringify(dump)}`]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('reports a line number past the end of the file', () => {
    expect(wrongLineNumbers(at('pages/Short.tsx', dump), allow('pages/Short.tsx', { line: 9, text: dump }))).toEqual([`pages/Short.tsx:9 is undefined, expected ${JSON.stringify(dump)}`]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('counts: an extra identical raw line in a listed file is unlisted', () => {
    const sources = at('pages/Dup.tsx', dump, 'const a = 1;', dump);
    const list = allow('pages/Dup.tsx', { line: 1, text: dump });
    expect(unlistedFindings(sources, list)).toEqual([`pages/Dup.tsx:3  ${dump}  — render with the catalogue (SourceView, LogPanel, ...) instead of adding an entry to rawRenderingAllowList.ts`]);
    expect(staleEntries(sources, list)).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('counts: a removed copy of two identical listed lines is stale', () => {
    const sources = at('pages/Dup.tsx', dump);
    const list = allow('pages/Dup.tsx', { line: 1, text: dump }, { line: 3, text: dump });
    expect(unlistedFindings(sources, list)).toEqual([]);
    expect(staleEntries(sources, list)).toEqual([`pages/Dup.tsx:3  ${dump}  — no longer raw rendering: remove this entry from rawRenderingAllowList.ts`]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('counts: two identical lines listed twice are accepted', () => {
    const sources = at('pages/Dup.tsx', dump, dump);
    const list = allow('pages/Dup.tsx', { line: 1, text: dump }, { line: 2, text: dump });
    expect([unlistedFindings(sources, list), staleEntries(sources, list), wrongLineNumbers(sources, list)]).toEqual([[], [], []]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('matches by file: the same text in another file is not covered', () => {
    expect(unlistedFindings(at('pages/B.tsx', dump), allow('pages/A.tsx', { line: 1, text: dump }))).toHaveLength(1);
  });
});

describe('the allow-list', () => {
  // [utest->req~frontend-retire-allow-list-ceiling~1]
  it('reports a ceiling that differs from the entries, naming both numbers', () => {
    expect(ceilingMismatch(14, new Array(13))).toBe('MAX_ALLOWED_OFFENDERS is 14 but the allow-list has 13 entries');
    expect(ceilingMismatch(12, new Array(13))).toBe('MAX_ALLOWED_OFFENDERS is 12 but the allow-list has 13 entries');
    expect(ceilingMismatch(13, new Array(13))).toBeUndefined();
  });

  // [utest->req~frontend-rendering-run-result-allow-list~1]
  it('has a ceiling of 8 after M2.3, as many as its entries', () => {
    expect(MAX_ALLOWED_OFFENDERS).toBe(8);
    expect(RAW_RENDERING_ALLOW_LIST).toHaveLength(8);
    expect(ceilingMismatch(MAX_ALLOWED_OFFENDERS, RAW_RENDERING_ALLOW_LIST)).toBeUndefined();
  });

  // [utest->req~frontend-retire-allow-list-ceiling~1]
  it('has a ceiling equal to its entries, numbered as a strictly increasing subset of 1 to 15', () => {
    expect(ceilingMismatch(MAX_ALLOWED_OFFENDERS, RAW_RENDERING_ALLOW_LIST)).toBeUndefined();
    const numbers = RAW_RENDERING_ALLOW_LIST.map((entry) => entry.offender);
    expect(numbers.every((n, i) => Number.isInteger(n) && n >= 1 && n <= 15 && (i === 0 || n > numbers[i - 1]))).toBe(true);
    for (const entry of RAW_RENDERING_ALLOW_LIST) {
      expect(entry.lines.length, `offender ${entry.offender}`).toBeGreaterThan(0);
      expect(entry.reason.length, `offender ${entry.offender}`).toBeGreaterThan(0);
    }
  });

  // [utest->req~frontend-retire-allow-list-leaves~1]
  // [utest->req~frontend-retire-reports-allow-list~1]
  // [utest->req~frontend-retire-library-allow-list~1]
  // [utest->req~frontend-rendering-run-result-allow-list~1]
  it('holds exactly the offenders that remain after M2.3', () => {
    expect(RAW_RENDERING_ALLOW_LIST.map((entry) => entry.offender)).toEqual([6, 8, 9, 10, 12, 13, 14, 15]);
    expect(UNLISTED_FINDINGS.map((entry) => entry.offender)).toEqual([16]);
    expect(UNLISTED_FINDINGS.map((entry) => entry.file)).toEqual(['pages/Workbench/SourcePanel.tsx']);
    expect([...RAW_RENDERING_ALLOW_LIST, ...UNLISTED_FINDINGS].filter((entry) => entry.file.startsWith('pages/Analysis'))).toEqual([]);
  });

  // [utest->req~frontend-retire-reports-allow-list~1]
  it('has no entry for the report editor, which slice 2 retires', () => {
    expect([...RAW_RENDERING_ALLOW_LIST, ...UNLISTED_FINDINGS].filter((entry) => entry.file === 'pages/Reports/RepDetail.tsx')).toEqual([]);
    expect(Object.keys(sources).filter((path) => path.endsWith('/pages/Reports/RepDetail.tsx'))).toEqual([]);
  });

  // [utest->req~frontend-retire-library-allow-list~1]
  it('has no entry for the library content view, which slice 3 retires', () => {
    expect([...RAW_RENDERING_ALLOW_LIST, ...UNLISTED_FINDINGS].filter((entry) => entry.file.startsWith('pages/Library/'))).toEqual([]);
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  // [utest->req~frontend-rendering-run-result-allow-list~1]
  it('retires the offenders in the slices ROADMAP names', () => {
    const slice = (n: number) => RAW_RENDERING_ALLOW_LIST.find((entry) => entry.offender === n)?.retiredBy;
    expect(slice(2)).toBeUndefined();
    for (const n of [1, 3, 4]) expect(slice(n), `offender ${n}`).toBeUndefined();
    expect(slice(5)).toBeUndefined();
    expect(slice(11)).toBeUndefined();
    for (const n of [8, 9, 10, 12, 13, 14, 15]) expect(slice(n), `offender ${n}`).toBe('M2.5');
    expect(slice(6)).toBe('M2.6');
  });

  // [utest->req~frontend-rendering-raw-hygiene~1]
  it('documents every finding that ROADMAP M2 does not list', () => {
    for (const entry of UNLISTED_FINDINGS) {
      expect(entry.reason, entry.file).toBe(UNLISTED_REASON);
      expect(entry.retiredBy, entry.file).toBeNull();
      expect(RAW_RENDERING_ALLOW_LIST.some((listed) => listed.file === entry.file), entry.file).toBe(false);
    }
  });
});
