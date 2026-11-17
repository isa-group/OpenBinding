import { describe, expect, it } from 'vitest';
import { FORBIDDEN_ADDRESS_SEGMENTS, OLD_ADDRESS_SEGMENTS, scanAddresses } from './vocabulary';

// The addresses the frontend builds hold no `cases`, `jobs` or `publications` segment (`req~frontend-nav-vocabulary-urls~1`, slices 13 and 14). The gateway
// API paths in the HTTP client layer (each module's `api/<name>Client.ts`) keep them. No file declares an old address: there is no redirect table. Nor do they hold the segments the composition
// vocabulary forbids, `deployments`, `scenarios` and `builds`, while `compositions`, `c` (the showcase) and `language` are addresses of their own.

const EVERY_SEGMENT = [...OLD_ADDRESS_SEGMENTS, ...FORBIDDEN_ADDRESS_SEGMENTS];

describe('the address scan', () => {
  it('reports an old address in a page and leaves the API client and the new addresses alone', () => {
    const files = {
      'pages/X.tsx':
        "export const X = ({ root, slug }) => <Link to={`${root}/cases/${slug}`} />;\nexport const all = '/app/runs';",
      'src/modules/problem/api/casesClient.ts':
        'export const one = (org, project, caseSlug) => `${projectRoot(org, project)}/cases/${enc(caseSlug)}`;',
    };
    expect(scanAddresses(files)).toEqual(['pages/X.tsx: ${root}/cases/${slug}']);
  });

  it('reports the forms of an address: a list, a query, a hash, a pattern and a plain string', () => {
    const files = {
      'a.ts': [
        "export const a = '/app/acme/demo/cases';",
        'export const b = `${root}/cases?create=problem`;',
        "export const c = '/app/:org/:project/cases/:case/:tab?';",
        'export const d = `${root}/cases#top`;',
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

  it('takes the segments as a parameter and reads the files in order', () => {
    const files = {
      'b.ts': "export const b = '/app/runs/jobs';",
      'a.ts': 'export const a = `${root}/jobs/new`;',
    };
    expect(scanAddresses(files, ['cases'])).toEqual([]);
    expect(scanAddresses(files, ['cases', 'jobs'])).toEqual([
      'a.ts: ${root}/jobs/new',
      'b.ts: /app/runs/jobs',
    ]);
  });

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
      'src/modules/run/api/runsClient.ts':
        'export const list = (org, project) => `${projectRoot(org, project)}/jobs?include_results=false`;',
    };
    expect(scanAddresses(files)).toEqual([
      'pages/J.tsx: /app/jobs',
      'pages/J.tsx: ${root}/jobs/${id}',
      'pages/J.tsx: /app/:org/:project/jobs/new',
    ]);
  });

  it('reports a deployments, scenarios or builds address, and leaves the compositions, showcase and language addresses alone', () => {
    expect(FORBIDDEN_ADDRESS_SEGMENTS).toEqual(['deployments', 'scenarios', 'builds']);
    const files = {
      'pages/C.tsx': [
        'export const list = `${root}/deployments`;',
        "export const one = '/app/acme/compositions/fleet/scenarios/2';",
        'export const built = `${root}/builds?latest=1`;',
        'export const fine = `/app/${org}/compositions/${slug}/versions`;',
        "export const showcase = '/c/acme/fleet-routing?version=1.0.0';",
        "export const language = '/language#composition=abc';",
        "export const word = 'deployments';",
      ].join('\n'),
      'src/modules/engine/api/enginesClient.ts':
        'export const deployments = (org) => `${orgRoot(org)}/deployments`;',
    };
    expect(scanAddresses(files, FORBIDDEN_ADDRESS_SEGMENTS)).toEqual([
      'pages/C.tsx: ${root}/deployments',
      'pages/C.tsx: /app/acme/compositions/fleet/scenarios/2',
      'pages/C.tsx: ${root}/builds?latest=1',
    ]);
    expect(
      scanAddresses(
        { 'pages/C.tsx': files['pages/C.tsx'].split('\n').slice(3).join('\n') },
        EVERY_SEGMENT
      )
    ).toEqual([]);
  });

  it('reports a publications address in a page but not /published or the API client', () => {
    const files = {
      'pages/P.tsx': [
        'export const list = `${root}/publications`;',
        'export const one = `${root}/publications/${id}`;',
        "export const fine = '/app/published';",
      ].join('\n'),
      'src/modules/engine/api/publicationsClient.ts':
        'export const list = (org) => `${orgRoot(org)}/publications`;',
    };
    expect(scanAddresses(files)).toEqual([
      'pages/P.tsx: ${root}/publications',
      'pages/P.tsx: ${root}/publications/${id}',
    ]);
  });
});

// Every application source, except the HTTP client layer (the scan skips it itself).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('the addresses of the application sources', () => {
  it('reads the application sources, the route table among them', () => {
    const paths = Object.keys(sources);
    expect(paths.length).toBeGreaterThan(200);
    expect(paths).toContain('/src/routes/router.tsx');
  });

  it('builds no address with a cases, jobs or publications segment, and declares none', () => {
    expect(scanAddresses(sources)).toEqual([]);
  });

  it('builds no address with a deployments, scenarios or builds segment', () => {
    expect(scanAddresses(sources, EVERY_SEGMENT)).toEqual([]);
  });

  it('builds the compositions, showcase and language addresses', () => {
    const addresses = Object.values(sources).join('\n');
    expect(addresses).toContain("COMPOSITIONS_SEGMENT = 'compositions'");
    expect(addresses).toMatch(/`\/c\/\$\{/);
    expect(addresses).toMatch(/['"`]\/language['"`]/);
  });
});
