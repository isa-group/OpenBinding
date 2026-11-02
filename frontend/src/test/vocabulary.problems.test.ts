import { describe, expect, it } from 'vitest';
import { formatFinding, isTestSupport, scanFiles, scanSource, wordPattern } from './vocabulary';

const CASE = wordPattern(['case', 'cases']);
const found = (source: string, words: RegExp = CASE) => scanSource(source, words).map((finding) => `${finding.where}: ${finding.text}`);

describe('the vocabulary scanner', () => {
  // [utest->req~frontend-nav-vocabulary-text~1]
  it('takes the words as a parameter and matches whole words in any letter case', () => {
    expect(['case', 'Case', 'CASES', 'No case matches', 'Cases:'].every((text) => CASE.test(text))).toBe(true);
    expect(['showcase', 'cased', 'suitcases', 'Problem'].some((text) => CASE.test(text))).toBe(false);
    expect(wordPattern(['job', 'jobs']).test('Jobs by state')).toBe(true);
    expect(CASE.test('Jobs by state')).toBe(false);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reports the words in JSX text with the line of the text', () => {
    const source = ['export const A = () => (', '  <section>', '    <h1>Cases</h1>', '    <p>Compare a case with another</p>', '  </section>', ');'].join('\n');
    expect(scanSource(source, CASE).map((finding) => [finding.line, finding.where, finding.text])).toEqual([
      [3, 'JSX text', 'Cases'], [4, 'JSX text', 'Compare a case with another'],
    ]);
    expect(found('const A = () => <p>Problems and versions</p>;')).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reports a single word in the text-like attributes', () => {
    const source = [
      'const A = () => (',
      '  <div label="Case" title="Cases" aria-label="Case" placeholder="Case" alt="Case" crumb="Case" heading="Case" />',
      ');',
    ].join('\n');
    expect(found(source)).toHaveLength(7);
    expect(found('const A = () => <Field label={`Case ${n}`} />;')).toEqual(['attribute label: Case X']);
    expect(found('const A = () => <Field label={ok ? "Case" : "Run"} />;')).toEqual(['attribute label: Case']);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reports a single word in an object property such as label', () => {
    expect(found("const trail = [{ label: 'Cases' }, { label: 'Problems' }];")).toEqual(['property label: Cases']);
    expect(found("const entry = { 'aria-label': 'Case', to: '/x' };")).toEqual(['property aria-label: Case']);
    expect(found("const entry = { label: `Case ${n}` };")).toEqual(['property label: Case X']);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reports a multi-word string literal or template anywhere', () => {
    expect(found("const message = 'No case matches your search';")).toEqual(['string: No case matches your search']);
    expect(found('const message = `Case “${name}” deleted.`;')).toEqual(['string: Case “X” deleted.']);
    expect(found("throw new Error('the case is gone');")).toEqual(['string: the case is gone']);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reports the strings of a JSX child expression, one word included', () => {
    expect(found("const A = () => <p>{ok ? 'Case' : 'Run'}</p>;")).toEqual(['JSX expression: Case']);
    expect(found("const A = () => <p>{count + ' cases'}</p>;")).toEqual(['JSX expression: cases']);
    expect(found("const A = () => <p>{kind === 'case' && 'ready'}</p>;")).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('does not report a single plain word outside the text-like places', () => {
    const source = [
      "const kind = 'case';",
      "if (entry.kind === 'case') run('cases');",
      "const A = () => <li className=\"case\" id=\"case\" data-testid=\"case\" role=\"case\" to=\"cases\" />;",
      "switch (kind) { case 'case': break; }",
      "const row = { type: 'case', slug: 'cases', name: 'case' };",
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('skips imports, exports, types and comments', () => {
    const source = [
      "import type { BindingCase } from '../../api/cases';",
      "import { list } from './the case list';",
      "export { list } from './the case list';",
      "type Kind = 'a case' | 'cases';",
      "interface Row { label: 'Case'; note: 'the case' }",
      'const row = load() as { label: "a case" };',
      "// a case in a comment",
      '/* New case */',
      '/** Case */',
      '{/* a case */}',
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('skips paths and URLs, and class and identifier lists', () => {
    const source = [
      'const a = `${root}/cases/${slug}`;',
      'const b = `${root}/jobs/new?case=${slug}&revision=1`;',
      "const c = 'https://example.org/the cases';",
      "const d = '/app/acme/demo/cases/new case';",
      "const e = 'case-row case-row-main';",
      "const f = 'case_row case/row';",
      "const A = () => <Link to={`${root}/cases/${slug}`} className={`case-row ${on ? 'case-on' : ''}`} />;",
    ].join('\n');
    expect(found(source)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('skips the subtree of code elements, SourceView and LogPanel', () => {
    const source = [
      'const A = () => (',
      '  <div>',
      '    <code>GET /v1/cases and the case list</code>',
      '    <SourceView label="Case" source="a case" />',
      '    <LogPanel title="Case log"><p>case</p></LogPanel>',
      '    <p>One case</p>',
      '  </div>',
      ');',
    ].join('\n');
    expect(scanSource(source, CASE).map((finding) => [finding.line, finding.text])).toEqual([[6, 'One case']]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reads TypeScript files that hold no JSX and numbers lines from 1', () => {
    const source = ["export const messages = {", "  empty: 'Case',", "  full: 'All cases',", '};'].join('\n');
    expect(scanSource(source, CASE, 'model.ts').map((finding) => [finding.line, finding.where])).toEqual([[2, 'property empty'], [3, 'string']]);
    expect(formatFinding({ file: 'model.ts', line: 2, where: 'property empty', text: 'Case' })).toBe('model.ts:2  property empty: "Case"');
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('tells application code from test support files', () => {
    for (const path of ['/src/a/X.test.tsx', '/src/a/xTestKit.tsx', '/src/a/testUtils.ts', '/src/test/fixtures/jobs.ts', '/src/a/fixtures.ts', '/src/pages/Pricing/pricingFixture.ts', '/src/components/rendering/runResultFixtures.ts', '/src/test/setup.ts', '/src/a/x.d.ts']) {
      expect(isTestSupport(path), path).toBe(true);
    }
    for (const path of ['/src/pages/Cases/CaseList.tsx', '/src/pages/Workbench/workbenchModel.ts', '/src/pages/Resources/parts.tsx']) {
      expect(isTestSupport(path), path).toBe(false);
    }
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('scans many files in order, skips test support and takes the words it is given', () => {
    const files = {
      '/src/b/B.tsx': 'export const B = () => <p>A case</p>;',
      '/src/a/A.tsx': "export const A = () => <p>A job</p>;",
      '/src/a/A.test.tsx': "it('a case', () => render(<p>A case</p>));",
      '/src/a/style.css': '.case { color: red }',
    };
    expect(scanFiles(files, CASE).map(formatFinding)).toEqual(['/src/b/B.tsx:1  JSX text: "A case"']);
    expect(scanFiles(files, wordPattern(['job'])).map(formatFinding)).toEqual(['/src/a/A.tsx:1  JSX text: "A job"']);
    expect(scanFiles(files, wordPattern(['case', 'job'])).map((finding) => finding.file)).toEqual(['/src/a/A.tsx', '/src/b/B.tsx']);
  });
});

// The sources of the problem area: the problem list and page, the workbench except its source panel, and the collections.
const sources = import.meta.glob(
  ['/src/pages/Cases/**/*.{ts,tsx}', '/src/pages/Workbench/**/*.{ts,tsx}', '/src/pages/Resources/**/*.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const area = Object.fromEntries(Object.entries(sources).filter(([path]) => !/\/pages\/Workbench\/SourcePanel[^/]*$/.test(path)));

describe('the problem area', () => {
  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reads the sources of pages/Cases, pages/Workbench (not SourcePanel) and pages/Resources', () => {
    const paths = Object.keys(area);
    expect(paths.filter((path) => path.includes('/pages/Cases/') && !isTestSupport(path)).length).toBeGreaterThan(10);
    expect(paths.filter((path) => path.includes('/pages/Workbench/') && !isTestSupport(path)).length).toBeGreaterThan(10);
    expect(paths.filter((path) => path.includes('/pages/Resources/') && !isTestSupport(path)).length).toBeGreaterThan(5);
    expect(paths.some((path) => /SourcePanel/.test(path))).toBe(false);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('shows no text with the word case or cases', () => {
    expect(scanFiles(area, CASE).map(formatFinding)).toEqual([]);
  });
});
