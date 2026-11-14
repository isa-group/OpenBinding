import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/ARCHITECTURE.md §5.4: the interface shows names, not digests. A digest-shaped string (`sha256-` followed
// by hexadecimal, a bare 40- or 64-hexadecimal run) or a UUID is rendered only by the export manifests and SourceView /
// LogPanel. This test reads the shipped sources (as src/hygiene.test.ts does) and fails on a literal of that shape, or on a
// use of `shortDigest` / `digestPrefix`, outside that allowed set.
//
// Every shipped file outside the allowed set is scanned.
// Known limits: short digests, digests built from a template and runtime data are not detected; the generated
// frontend/src/content/changelog.json is rendered on About but is not scanned (JSON is not in the glob).

const files = import.meta.glob(['/src/**/*.{ts,tsx,css}', '!/src/**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// Vitest hands a `?raw` stylesheet over empty, so the stylesheets are read from disk (this file sits in src/test/).
const root = join(import.meta.dirname ?? join(process.cwd(), 'src', 'test'), '..');
const stylesheets = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.css'))
  .map((name): [string, string] => [`/src/${name.replaceAll('\\', '/')}`, readFileSync(join(root, name), 'utf8')]);

// Test-support files that are not shipped; anchored on a path segment so a shipped `latestUtils.ts` is still scanned.
const TEST_KIT = /\/(testKit|[A-Za-z]*TestUtils)\.tsx?$|\/src\/test\/setup\.ts$/;

// Every file the TEST_KIT pattern leaves out of the scan; a new test-kit file needs an edit here.
const TEST_KIT_FILES: readonly string[] = [
  '/src/pages/Admin/adminTestUtils.tsx',
  '/src/pages/Organization/testKit.tsx',
  '/src/pages/Project/testKit.tsx',
  '/src/test/setup.ts',
];

const all = [...Object.entries(files).filter(([path]) => !path.endsWith('.css')), ...stylesheets];
const shipped = all.filter(([path]) => !TEST_KIT.test(path));

const ALLOWED = /\/src\/(components\/rendering\/(SourceView|LogPanel)|utils\/(digest|uuid|canonicalDigest)|api\/|test\/)|[Ff]ixtures?\.ts$/;

// Every shipped file the ALLOWED pattern exempts; a new exempt-named file needs an edit here.
const EXEMPT_FILES: readonly string[] = [
  // api layer: request and response types carry ids and digests as data
  '/src/api/auth.ts',
  '/src/api/cases.ts',
  '/src/api/client.ts',
  '/src/api/compositions.ts',
  '/src/api/generator.ts',
  '/src/api/health.ts',
  '/src/api/' + 'jobs.ts',
  '/src/api/library.ts',
  '/src/api/limitNotice.ts',
  '/src/api/platform.ts',
  '/src/api/problem.ts',
  '/src/api/workbench.ts',
  // log and source views: raw engine output and source text are shown verbatim
  '/src/components/rendering/LogPanel.css',
  '/src/components/rendering/LogPanel.tsx',
  '/src/components/rendering/SourceView.css',
  '/src/components/rendering/SourceView.tsx',
  // fixtures: sample data for tests and demos, with realistic digests and ids
  '/src/components/rendering/runResultFixtures.ts',
  '/src/pages/Cases/fixtures.ts',
  '/src/pages/Organization/auditFixture.ts',
  '/src/pages/Pricing/pricingFixture.ts',
  '/src/pages/Project/packageFixture.ts',
  '/src/test/fixtures/admin.ts',
  '/src/test/fixtures/engines.ts',
  '/src/test/fixtures/jobs.ts',
  '/src/test/fixtures/resources.ts',
  '/src/test/fixtures/studies.ts',
  // test support under src/test/, not shipped behaviour
  '/src/test/rawRenderingAllowList.ts',
  '/src/test/vocabulary.ts',
  // utils: the digest and uuid helpers themselves
  '/src/utils/canonicalDigest.ts',
  '/src/utils/digest.ts',
  '/src/utils/uuid.ts',
];

const DIGEST_LITERAL = /sha256-[0-9a-fA-F]{8,}|(?<![0-9a-fA-F])(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})(?![0-9a-fA-F])/;
const UUID_LITERAL = /(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])/;
const SHORTENER = /\b(?:shortDigest|digestPrefix)\b/;

const checked = shipped.filter(([path]) => !ALLOWED.test(path));

const grep = (pattern: RegExp, entries: ReadonlyArray<[string, string]> = checked) => entries
  .flatMap(([path, text]) => text.split('\n').map((line, index) => ({ at: `${path}:${index + 1}`, line })).filter(({ line }) => pattern.test(line)))
  .map(({ at, line }) => `${at}  ${line.trim()}`);

describe('names, not digests: no digest-shaped string or UUID outside the places that cite', () => {
  it('reads files', () => {
    expect(shipped.length).toBeGreaterThan(100);
    expect(checked.length).toBeGreaterThan(50);
  });

  it('reads the stylesheets from disk with their content', () => {
    expect(stylesheets.length).toBeGreaterThan(0);
    const logPanel = stylesheets.find(([path]) => path === '/src/components/rendering/LogPanel.css');
    expect(logPanel?.[1].trim().length).toBeGreaterThan(0);
  });

  it('leaves out exactly the files of the explicit test-kit list', () => {
    expect(all.map(([path]) => path).filter((path) => TEST_KIT.test(path)).sort()).toEqual([...TEST_KIT_FILES].sort());
  });

  it('exempts exactly the files of the explicit allowed list', () => {
    expect(shipped.map(([path]) => path).filter((path) => ALLOWED.test(path)).sort()).toEqual([...EXEMPT_FILES].sort());
  });

  it('carries no digest-shaped literal or UUID outside the allowed set', () => {
    expect(grep(DIGEST_LITERAL)).toEqual([]);
    expect(grep(UUID_LITERAL)).toEqual([]);
  });

  it('neither imports nor calls shortDigest or digestPrefix outside the allowed set', () => {
    expect(grep(SHORTENER)).toEqual([]);
  });
});

describe('the scan pipeline', () => {
  it('reports a match as path:line  text', () => {
    const entries: Array<[string, string]> = [['/src/x/Foo.ts', 'const a = 1;\n  const b = shortDigest(x);  \n']];
    expect(grep(SHORTENER, entries)).toEqual(['/src/x/Foo.ts:2  const b = shortDigest(x);']);
    expect(grep(DIGEST_LITERAL, entries)).toEqual([]);
  });

  it('skips the test-kit names on a path segment only', () => {
    const paths = ['/src/pages/A/testKit.tsx', '/src/pages/A/adminTestUtils.ts', '/src/test/setup.ts'];
    expect(paths.every((path) => TEST_KIT.test(path))).toBe(true);
    const shippedNames = ['/src/utils/latestUtils.ts', '/src/pages/A/mytestKit.tsx', '/src/pages/A/setup.ts', '/src/x/test/setup.ts.bak'];
    expect(shippedNames.some((path) => TEST_KIT.test(path))).toBe(false);
    const entry: [string, string] = ['/src/utils/latestUtils.ts', `const d = 'sha256-${'ab'.repeat(32)}';`];
    const scanned = [entry].filter(([path]) => !TEST_KIT.test(path) && !ALLOWED.test(path));
    expect(grep(DIGEST_LITERAL, scanned)).toHaveLength(1);
  });
});

describe('the digest detectors', () => {
  const hex64 = 'a1b2c3d4'.repeat(8);
  const hex40 = '0123456789abcdef0123456789abcdef01234567';
  const flagged = (text: string) => DIGEST_LITERAL.test(text) || UUID_LITERAL.test(text);

  it('catch sha256- plus 64 hex, a bare 64-hex, a 40-hex git SHA and a UUID', () => {
    expect(DIGEST_LITERAL.test(`'sha256-${hex64}'`)).toBe(true);
    expect(DIGEST_LITERAL.test(`"${hex64}"`)).toBe(true);
    expect(DIGEST_LITERAL.test(`commit ${hex40}`)).toBe(true);
    expect(UUID_LITERAL.test('id: 123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('do not flag an ordinary word, a 12-hex string or the prose word sha256-', () => {
    expect(flagged('the quick brown fox')).toBe(false);
    expect(flagged('abcdef012345')).toBe(false);
    expect(flagged('Shown as sha256- followed by a prefix')).toBe(false);
    expect(flagged(`${hex64}0`)).toBe(false);
  });

  it('catch upper-case digests and UUIDs and a prefixed 64-hex run', () => {
    expect(DIGEST_LITERAL.test(`sha256-${hex64.toUpperCase()}`)).toBe(true);
    expect(DIGEST_LITERAL.test(`"${hex64.toUpperCase()}"`)).toBe(true);
    expect(UUID_LITERAL.test('ID: 123E4567-E89B-12D3-A456-426614174000')).toBe(true);
    expect(DIGEST_LITERAL.test(`x_${hex64}`)).toBe(true);
  });

  it('do not flag a UUID with a 13-hex tail or sha256- with fewer than 8 hex', () => {
    expect(UUID_LITERAL.test('123e4567-e89b-12d3-a456-4266141740001')).toBe(false);
    expect(DIGEST_LITERAL.test('sha256-abc')).toBe(false);
  });

  it('catch the shorteners as whole words only', () => {
    expect(SHORTENER.test('import { shortDigest } from "../utils/digest"')).toBe(true);
    expect(SHORTENER.test('digestPrefix(x)')).toBe(true);
    expect(SHORTENER.test('digestPrefixes')).toBe(false);
  });
});
