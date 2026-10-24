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
//   Anything else is not rendered: request bodies, storage, Blob/download/copy calls, comparisons, keys, template literals, helpers.
// Limit: a call on a different line from the `{` that opened its expression is not seen. Comment lines are skipped.

// [utest->req~frontend-rendering-raw-hygiene~1]

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
  const open = stack.pop();
  if (open === undefined) return false;
  const head = prefix.slice(0, open);
  const before = head.trimEnd();
  const inside = prefix.slice(open + 1);
  // An attribute value is rendered only when it is the call itself (`value={JSON.stringify(`), not a handler or a wrapped call.
  if (/[\w-]=$/.test(head)) return inside.trim() === '';
  // Not a child: an arrow body block, a template literal `${`.
  if (before.endsWith('=>') || before.endsWith('$')) return false;
  // A child expression on its own line (the usual layout of a multi-line element).
  if (before === '') return inside.trim() === '';
  // JS punctuation before the brace means an object literal or a block, not JSX.
  if (/[(,=?[&|]$/.test(before)) return false;
  // Otherwise a child: after a tag, a sibling expression or JSX text (`<p>Value: {`).
  return /<[A-Za-z>]/.test(before);
}

export function findRawRendering(text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (/^(\/\/|\/\*|\*)/.test(line)) return;
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

const accepted = [...RAW_RENDERING_ALLOW_LIST, ...UNLISTED_FINDINGS];
const key = (file: string, text: string) => `${file}\u0000${text}`;
const acceptedKeys = new Set(accepted.flatMap((entry) => entry.lines.map((l) => key(entry.file, l.text))));

describe('the detector of raw rendering', () => {
  it('reports a <pre> tag', () => {
    expect(findRawRendering('<pre>{text}</pre>')).toHaveLength(1);
    expect(findRawRendering('  <pre className="x" aria-label="Log">')).toHaveLength(1);
    expect(findRawRendering('<pre tabIndex={0}><code>{source}</code></pre>')[0]?.kind).toBe('pre');
  });

  it('reports a stringify rendered as a JSX child', () => {
    expect(findRawRendering('<code>{JSON.stringify(option.rest)}</code>')).toHaveLength(1);
    expect(findRawRendering("<dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>")).toHaveLength(1);
    expect(findRawRendering('<dd>{ok ? <>{a} <small>{b}</small></> : JSON.stringify(ref)}</dd>')).toHaveLength(1);
    expect(findRawRendering('  {JSON.stringify(x)}')).toHaveLength(1);
    expect(findRawRendering('<p>Value: {JSON.stringify(x)}</p>')).toHaveLength(1);
    expect(findRawRendering('<dd>{a} {JSON.stringify(b)}</dd>')).toHaveLength(1);
    expect(findRawRendering('<ul>{items.map((i) => JSON.stringify(i))}</ul>')).toHaveLength(1);
  });

  it('reports a stringify given as a JSX attribute value', () => {
    expect(findRawRendering('<CodeEditor value={JSON.stringify(doc, null, 2)} readOnly />')).toHaveLength(1);
  });

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

  it('numbers lines from 1 and keeps the trimmed text', () => {
    expect(findRawRendering('const a = 1;\n    <pre>{a}</pre>')).toEqual([{ line: 2, text: '<pre>{a}</pre>', kind: 'pre' }]);
  });

  it('exempts the catalogue files by exact path and nothing else', () => {
    const sample = '<pre>{JSON.stringify(x)}</pre>';
    const hits = (file: string) => scan({ [`/src/${file}`]: sample }).length;
    for (const file of EXEMPT_FILES) expect(hits(file), file).toBe(0);
    expect(hits('components/rendering/SourceViewer.tsx')).toBe(1);
    expect(hits('pages/components/rendering/SourceView.tsx')).toBe(1);
    expect(hits('pages/Jobs/JobResult.tsx')).toBe(1);
  });

  it('exempts exactly the two catalogue components', () => {
    expect(EXEMPT_FILES).toEqual(['components/rendering/SourceView.tsx', 'components/rendering/LogPanel.tsx']);
    for (const file of EXEMPT_FILES) expect(files[`/src/${file}`], file).toBeDefined();
  });
});

describe('raw rendering in the application sources', () => {
  it('reads the sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(Object.keys(sources).some((path) => path.startsWith('/src/test/'))).toBe(false);
  });

  it('has no raw rendering outside the allow-list', () => {
    const unexpected = scan(sources).filter(({ file, text }) => !acceptedKeys.has(key(file, text)));
    expect(
      unexpected.map(({ file, line, text }) => `${file}:${line}  ${text}  — render with the catalogue (SourceView, LogPanel, ...) instead of adding an entry to rawRenderingAllowList.ts`),
    ).toEqual([]);
  });

  it('has no stale allow-list entry: the list may only shrink', () => {
    const found = new Set(scan(sources).map(({ file, text }) => key(file, text)));
    const stale = accepted.flatMap((entry) => entry.lines.filter((l) => !found.has(key(entry.file, l.text))).map((l) => `${entry.file}:${l.line}  ${l.text}  — no longer raw rendering: remove this entry from rawRenderingAllowList.ts`));
    expect(stale).toEqual([]);
  });

  it('keeps the line numbers of the allow-list correct', () => {
    const wrong = accepted.flatMap((entry) => entry.lines.flatMap((l) => {
      const actual = sources[`/src/${entry.file}`]?.split('\n')[l.line - 1]?.trim();
      return actual === l.text ? [] : [`${entry.file}:${l.line} is ${JSON.stringify(actual)}, expected ${JSON.stringify(l.text)}`];
    }));
    expect(wrong).toEqual([]);
  });
});

describe('the allow-list', () => {
  it('has exactly the 15 offenders of ROADMAP M2, numbered 1 to 15, and a ceiling that only goes down', () => {
    expect(MAX_ALLOWED_OFFENDERS).toBe(15);
    expect(RAW_RENDERING_ALLOW_LIST.length).toBeLessThanOrEqual(MAX_ALLOWED_OFFENDERS);
    expect(RAW_RENDERING_ALLOW_LIST.map((entry) => entry.offender)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    for (const entry of RAW_RENDERING_ALLOW_LIST) {
      expect(entry.lines.length, `offender ${entry.offender}`).toBeGreaterThan(0);
      expect(entry.reason.length, `offender ${entry.offender}`).toBeGreaterThan(0);
    }
  });

  it('retires the offenders in the slices ROADMAP names', () => {
    const slice = (n: number) => RAW_RENDERING_ALLOW_LIST.find((entry) => entry.offender === n)?.retiredBy;
    for (const n of [1, 2, 3, 4]) expect(slice(n), `offender ${n}`).toBe('M2.3');
    for (const n of [5, 7, 11]) expect(slice(n), `offender ${n}`).toBe('M2.4');
    for (const n of [8, 9, 10, 12, 13, 14, 15]) expect(slice(n), `offender ${n}`).toBe('M2.5');
    expect(slice(6)).toBe('M2.6');
  });

  it('documents every finding that ROADMAP M2 does not list', () => {
    for (const entry of UNLISTED_FINDINGS) {
      expect(entry.reason, entry.file).toBe(UNLISTED_REASON);
      expect(entry.retiredBy, entry.file).toBeNull();
      expect(RAW_RENDERING_ALLOW_LIST.some((listed) => listed.file === entry.file), entry.file).toBe(false);
    }
  });
});
