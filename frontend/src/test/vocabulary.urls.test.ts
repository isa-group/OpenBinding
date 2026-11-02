import { describe, expect, it } from 'vitest';
import { scanAddresses } from './vocabulary';

// The addresses the frontend builds hold no `cases` segment (`req~frontend-nav-vocabulary-urls~1`, slice 13). The gateway API paths in
// `src/api/` keep it. The route areas, the moved table and the retired table name the old addresses on purpose, to redirect them.

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
      ].join('\n'),
      'a.test.tsx': "expect(href).toBe('/app/acme/demo/cases');",
      'fixtures/b.ts': "export const old = '/app/acme/demo/cases';",
    };
    expect(scanAddresses(files)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('takes the segments as a parameter and reads the files in order', () => {
    const files = { 'b.ts': "export const b = '/app/runs/jobs';", 'a.ts': "export const a = `${root}/jobs/new`;" };
    expect(scanAddresses(files)).toEqual([]);
    expect(scanAddresses(files, ['cases', 'jobs'])).toEqual(['a.ts: ${root}/jobs/new', 'b.ts: /app/runs/jobs']);
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
  it('builds no address with a cases segment', () => {
    expect(scanAddresses(scanned)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-urls~1]
  it('finds the old address where the declaring files name it', () => {
    const declaring = Object.fromEntries(Object.entries(sources).filter(([path]) => DECLARING.test(path)));
    expect(scanAddresses(declaring).length).toBeGreaterThan(0);
  });
});
