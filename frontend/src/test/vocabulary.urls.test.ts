import { describe, expect, it } from 'vitest';
import { OLD_ADDRESS_SEGMENTS, scanAddresses } from './vocabulary';

// The addresses the frontend builds hold no `cases`, `jobs` or `publications` segment (`req~frontend-nav-vocabulary-urls~1`, slices 13 and 14). The gateway
// API paths in `src/api/` keep them. The route areas, the moved table and the retired table name the old addresses on purpose, to redirect them.

describe('the address scan', () => {
  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('reports an old address in a page and leaves the API client and the new addresses alone', () => {
    const files = {
      'pages/X.tsx': "export const X = ({ root, slug }) => <Link to={`${root}/cases/${slug}`} />;\nexport const all = '/app/runs';",
      'src/api/cases.ts': 'export const one = (org, project, caseSlug) => `${projectRoot(org, project)}/cases/${enc(caseSlug)}`;',
    };
    expect(scanAddresses(files)).toEqual(['pages/X.tsx: ${root}/cases/${slug}']);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('reports the forms of an address: a list, a query, a hash, a pattern and a plain string', () => {
    const files = {
      'a.ts': [
        "export const a = '/app/acme/demo/cases';",
        'export const b = `${root}/cases?create=problem`;',
        "export const c = '/app/:org/:project/cases/:case/:tab?';",
        "export const d = `${root}/cases#top`;",
        'export const e = `${root}/cases${search}`;',
      ].join('\n'),
    };
    expect(scanAddresses(files)).toEqual([
      'a.ts: /app/acme/demo/cases',
      'a.ts: ${root}/cases?create=problem',
      'a.ts: /app/:org/:project/cases/:case/:tab?',
      'a.ts: ${root}/cases#top',
      'a.ts: ${root}/cases${search}',
    ]);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('does not report the new addresses, a section key, a longer word, a comment, an import or a test file', () => {
    const files = {
      'a.tsx': [
        "import { casesApi } from '../../api/cases';",
        '// the list lives at ${root}/cases in the old layout',
        "export const key = 'cases';",
        "export const kinds = ['jobs', 'cases', 'artifacts'];",
        'export const a = `${root}/problems/${slug}`;',
        "export const b = '/app/acme/demo/cases-and-more';",
        "export const c = '/app/acme/demo/showcases';",
        "export const d = 'GET /v1/organizations/acme/projects/demo/problems';",
        "export const e = '/internal/v1/jobs/{id}';",
        "export const f = 'POST /v1/cases';",
      ].join('\n'),
      'a.test.tsx': "expect(href).toBe('/app/acme/demo/cases');",
      'fixtures/b.ts': "export const old = '/app/acme/demo/cases';",
    };
    expect(scanAddresses(files)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('takes the segments as a parameter and reads the files in order', () => {
    const files = { 'b.ts': "export const b = '/app/runs/jobs';", 'a.ts': "export const a = `${root}/jobs/new`;" };
    expect(scanAddresses(files, ['cases'])).toEqual([]);
    expect(scanAddresses(files, ['cases', 'jobs'])).toEqual(['a.ts: ${root}/jobs/new', 'b.ts: /app/runs/jobs']);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('holds the old cases, jobs and publications segments by default, and reports a jobs address in a page but not the API client or the new one', () => {
    expect(OLD_ADDRESS_SEGMENTS).toEqual(['cases', 'jobs', 'publications']);
    const files = {
      'pages/J.tsx': [
        "export const history = '/app/jobs';",
        'export const one = `${root}/jobs/${id}`;',
        "export const launch = '/app/:org/:project/jobs/new';",
        "export const fine = '/app/runs';",
        'export const fineToo = `${root}/runs/${id}`;',
      ].join('\n'),
      'src/api/runsClient.ts': 'export const list = (org, project) => `${projectRoot(org, project)}/jobs?include_results=false`;',
    };
    expect(scanAddresses(files)).toEqual([
      'pages/J.tsx: /app/jobs',
      'pages/J.tsx: ${root}/jobs/${id}',
      'pages/J.tsx: /app/:org/:project/jobs/new',
    ]);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('reports a publications address in a page but not /published or the API client', () => {
    const files = {
      'pages/P.tsx': [
        'export const list = `${root}/publications`;',
        'export const one = `${root}/publications/${id}`;',
        "export const fine = '/app/published';",
      ].join('\n'),
      'src/api/publications.ts': 'export const list = (org) => `${orgRoot(org)}/publications`;',
    };
    expect(scanAddresses(files)).toEqual([
      'pages/P.tsx: ${root}/publications',
      'pages/P.tsx: ${root}/publications/${id}',
    ]);
  });
});

// Every application source, except the HTTP client layer (the scan skips it itself) and the files that declare the old addresses to
// redirect them.
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const DECLARING = /^\/src\/routes\/(areas\/|moved\.ts$|retiredRoutes\.tsx$)/;
const scanned = Object.fromEntries(Object.entries(sources).filter(([path]) => !DECLARING.test(path)));

describe('the addresses of the application sources', () => {
  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('reads the application sources and leaves out the files that declare the old addresses', () => {
    const paths = Object.keys(scanned);
    expect(paths.length).toBeGreaterThan(200);
    expect(paths.some((path) => DECLARING.test(path))).toBe(false);
    expect(Object.keys(sources).filter((path) => DECLARING.test(path)).length).toBeGreaterThan(5);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('builds no address with a cases, jobs or publications segment', () => {
    expect(scanAddresses(scanned)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('finds the old address where the declaring files name it', () => {
    const declaring = Object.fromEntries(Object.entries(sources).filter(([path]) => DECLARING.test(path)));
    expect(scanAddresses(declaring).length).toBeGreaterThan(0);
  });
});
