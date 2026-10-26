import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions } from './registry';
import { RETIRED_ROUTES } from './retiredRoutes';

/** The text of every string and template literal of a source, comments skipped. A template keeps its `${…}` as written. */
function literalsOf(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  const quoted = (quote: string) => {
    let j = i + 1;
    while (j < text.length && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    if (text[j] === quote) {
      found.push(text.slice(i + 1, j));
      i = j + 1;
    } else {
      i += 1; // an apostrophe in JSX text or a regular expression, not a literal
    }
  };
  const template = () => {
    const start = ++i;
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '$' && text[i + 1] === '{') {
        i += 2;
        code(true);
      } else i += 1;
    }
    found.push(text.slice(start, i));
    i += 1;
  };
  function code(insideTemplate: boolean) {
    let depth = 0;
    while (i < text.length) {
      const char = text[i];
      if (char === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i += 1;
      } else if (char === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
      } else if (char === "'" || char === '"') quoted(char);
      else if (char === '`') template();
      else {
        if (char === '{') depth += 1;
        else if (char === '}') {
          if (insideTemplate && depth === 0) {
            i += 1;
            return;
          }
          depth -= 1;
        }
        i += 1;
      }
    }
  }
  code(false);
  return found;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A `:param` segment as written in a literal: a value of any one segment, or a `${…}` expression. */
const PARAM_SEGMENT = '(?:\\$\\{[^}]*\\}|[^/?#$]+)';
/** What may follow a retired path: the end of the literal, `/`, `?`, `#` or `${`. */
const AFTER_PATH = '(?:$|[/?#]|\\$\\{)';

/** The patterns of a retired path: the whole address and, for a path with `:params`, its tail after an interpolation (`${root}/reports`). */
function patternsOf(path: string): RegExp[] {
  const segments = path.split('/').slice(1);
  const isParam = (segment: string) => segment.startsWith(':');
  const build = (list: string[], head: string) => new RegExp(`^${head}${list.map((s) => `/${isParam(s) ? PARAM_SEGMENT : escapeRegExp(s)}`).join('')}${AFTER_PATH}`);
  const patterns = [build(segments, '')];
  const first = segments.findIndex(isParam);
  if (first === -1) return patterns;
  let end = first;
  while (end < segments.length && isParam(segments[end])) end += 1;
  if (end < segments.length) patterns.push(build(segments.slice(end), '\\$\\{[^}]*\\}'));
  return patterns;
}

// [impl->req~frontend-retire-no-link-to-retired~1]
// [impl->req~frontend-retire-reports-no-link~1]
// [impl->req~frontend-retire-library-no-link~1]
/**
 * `<file>: <literal>` for every string or template literal of the sources that starts with a retired path followed by the end,
 * `/`, `?`, `#` or `${`. A `:param` of the path stands for any one segment or `${…}`; for such a path a literal that starts with
 * an interpolation and goes on with the part after the parameters (`${root}/reports`) counts too, except in the API client (`src/api/`),
 * whose endpoints are not addresses of the application. The file `routes/retiredRoutes.tsx` (and no other) is exempt.
 * Known limit: an address built from pieces is not seen.
 */
export function retiredAddresses(sources: Record<string, string>, retiredPaths: readonly string[]): string[] {
  const hits: string[] = [];
  const all = retiredPaths.map(patternsOf);
  for (const [file, text] of Object.entries(sources)) {
    const name = file.replace(/^(\.\.\/|src\/)/, '');
    if (name === 'routes/retiredRoutes.tsx') continue;
    const patterns = name.startsWith('api/') ? all.map(([whole]) => [whole]) : all;
    for (const literal of literalsOf(text)) {
      if (patterns.some((list) => list.some((pattern) => pattern.test(literal)))) hits.push(`${file}: ${literal}`);
    }
  }
  return hits;
}

/** Every source file that is not a test, as text. */
const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true });

/**
 * The static internal addresses written in the code: `to="/x"`, `to: '/x'`, `href: '/x'`, `to={`/x/${id}`}`, `navigate('/x')`.
 * Addresses built from a variable first (`${base}/x`) are not static and are left to the tests of their screen.
 */
const LINK = /(?:\bto|\bhref|\bfrom)\s*(?:=\s*\{?|:\s*)(['"`])(\/[^'"`]*)\1|\bnavigate\(\s*(['"`])(\/[^'"`]*)\3/g;

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

/** The route an address leads to, with the query, the hash and any `${…}` filled in by an example value. */
const pathOf = (address: string) => address.replace(/\$\{[^}]*\}/g, 'sample').split(/[?#]/)[0];

function staticLinks() {
  const found: Array<{ file: string; address: string }> = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const match of text.matchAll(LINK)) found.push({ file: file.replace('../', 'src/'), address: match[2] ?? match[4] });
  }
  return found;
}

describe('internal links written in the code', () => {
  it('finds the links to check', () => {
    const addresses = staticLinks().map((link) => link.address);
    expect(addresses.length).toBeGreaterThan(50);
    expect(addresses).toContain('/app/jobs');
  });

  it('resolve to a screen of routes/d1..d8', () => {
    // Where one `${…}` stands for more than one segment: the engine slug of a resolved location is `namespace/name`.
    const composed = new Set(['/engines/${slug}/${location.version_or_revision}']);
    const lost = staticLinks()
      .filter(({ address }) => !composed.has(address) && !matchRoutes(config, pathOf(address)))
      .map(({ file, address }) => `${file}: ${address}`);
    expect(lost).toEqual([]);
  });

  it('do not point at the addresses the redesign retired', () => {
    const retired = /^\/(playground|profiles|schemas|team|research|funding|contributions|changelog)(\/|$)|^\/app\/analysis\?job=|^\/app\/[^/]+\/[^/]+\/(verifier|analytics|artifacts|reports|library|resources)(\/|$)|^\/app\/[^/]+\/library(\/|$)/;
    const old = staticLinks().filter(({ address }) => retired.test(address)).map(({ file, address }) => `${file}: ${address}`);
    expect(old).toEqual([]);
  });
});

describe('the scan for retired addresses', () => {
  const retired = ['/app/analysis', '/app/analysis/workspace'];
  const scan = (file: string, text: string) => retiredAddresses({ [file]: text }, retired);

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('finds an address kept in a variable', () => {
    expect(scan('pages/X.tsx', 'const href = `/app/analysis/workspace?job=${id}`;')).toEqual(['pages/X.tsx: /app/analysis/workspace?job=${id}']);
    expect(scan('pages/X.tsx', "const a = '/app/analysis';")).toEqual(['pages/X.tsx: /app/analysis']);
    expect(scan('pages/X.tsx', 'const a = `/app/analysis/workspace?job=${id}\n&x=1`;')).toEqual(['pages/X.tsx: /app/analysis/workspace?job=${id}\n&x=1']);
  });

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('finds a retired path followed by a hash, and one inside a template expression', () => {
    expect(scan('pages/X.tsx', 'go("/app/analysis#top");')).toEqual(['pages/X.tsx: /app/analysis#top']);
    expect(scan('pages/X.tsx', 'const a = `x${ok ? "/app/analysis" : ""}`;')).toEqual(['pages/X.tsx: /app/analysis']);
    expect(scan('pages/X.tsx', 'const a = `${base}/app/analysis`;')).toEqual([]);
  });

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('does not report look-alikes, comments or apostrophes in text', () => {
    const source = [
      "const a = '/app/analysisx';",
      "const b = '/v1/analysis/sources';",
      "const c = '/app/:org/:project/studies';",
      "// '/app/analysis' in a comment",
      "/* '/app/analysis' */",
      "const d = <p>don't</p>;",
    ].join('\n');
    expect(scan('pages/X.tsx', source)).toEqual([]);
  });

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('known limit: an apostrophe or a // in JSX text hides a later literal on the same line', () => {
    expect(scan('pages/X.tsx', "const a = <p>Don't open {'/app/analysis'}</p>;")).toEqual([]);
  });

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('exempts the table of retired addresses and no other file', () => {
    expect(scan('routes/retiredRoutes.tsx', "const a = '/app/analysis';")).toEqual([]);
    expect(scan('src/routes/retiredRoutes.tsx', "const a = '/app/analysis';")).toEqual([]);
    expect(scan('pages/retiredRoutes.tsx', "const a = '/app/analysis';")).toHaveLength(1);
    expect(scan('pages/routes/retiredRoutes.tsx', "const a = '/app/analysis';")).toHaveLength(1);
    expect(scan('routes/retiredRoutes.test.tsx', "const a = '/app/analysis';")).toHaveLength(1);
  });

  describe('for retired paths that have :params', () => {
    const withParams = ['/app/:org/:project/reports', '/app/:org/:project/reports/:report'];
    const scanParams = (file: string, text: string) => retiredAddresses({ [file]: text }, withParams);

    // [utest->req~frontend-retire-reports-no-link~1]
    it('finds the whole address, written with values or with ${…} for the parameters', () => {
      expect(scanParams('pages/X.tsx', 'const a = `/app/${org}/${project}/reports`;')).toEqual(['pages/X.tsx: /app/${org}/${project}/reports']);
      expect(scanParams('pages/X.tsx', "const a = '/app/acme/demo/reports/x';")).toEqual(['pages/X.tsx: /app/acme/demo/reports/x']);
      expect(scanParams('pages/X.tsx', 'const a = `/app/${org}/${project}/reports/${slug}`;')).toEqual(['pages/X.tsx: /app/${org}/${project}/reports/${slug}']);
      expect(scanParams('pages/X.tsx', "const a = '/app/acme/demo/reports';")).toEqual(['pages/X.tsx: /app/acme/demo/reports']);
    });

    // [utest->req~frontend-retire-reports-no-link~1]
    it('ends the retired path at the end, /, ?, # or ${', () => {
      for (const address of ['/app/acme/demo/reports', '/app/acme/demo/reports/', '/app/acme/demo/reports?x=1', '/app/acme/demo/reports#top', '/app/acme/demo/reports${suffix}']) {
        expect(scanParams('pages/X.tsx', `const a = \`${address}\`;`), address).toHaveLength(1);
      }
    });

    // [utest->req~frontend-retire-reports-no-link~1]
    it('finds the tail written after an interpolation', () => {
      expect(scanParams('pages/X.tsx', 'const a = `${root}/reports`;')).toEqual(['pages/X.tsx: ${root}/reports']);
      expect(scanParams('pages/X.tsx', 'const a = `${root}/reports/${slug}`;')).toEqual(['pages/X.tsx: ${root}/reports/${slug}']);
      expect(scanParams('pages/X.tsx', 'const a = `${root}/reports?x`;')).toEqual(['pages/X.tsx: ${root}/reports?x']);
      expect(scanParams('pages/X.tsx', 'const a = `${root}/reports#top`;')).toEqual(['pages/X.tsx: ${root}/reports#top']);
      expect(scanParams('pages/X.tsx', 'to={`${root(org, project)}/reports`}')).toEqual(['pages/X.tsx: ${root(org, project)}/reports']);
    });

    // [utest->req~frontend-retire-reports-no-link~1]
    it('does not report look-alikes or the addresses that replace the retired ones', () => {
      const source = [
        "const a = '/app/acme/demo/reportsx';",
        'const b = `${root}/reportsx`;',
        "const c = '/app/:org/:project/studies';",
        'const d = `/app/${org}/${project}/publications`;',
        'const e = `${root}/publications`;',
        "const f = '/app/acme/reports';",
        "const g = '/reports';",
        "// '/app/acme/demo/reports' in a comment",
      ].join('\n');
      expect(scanParams('pages/X.tsx', source)).toEqual([]);
    });

    // [utest->req~frontend-retire-reports-no-link~1]
    it('leaves the endpoints of the API client alone, and nothing else', () => {
      const endpoint = 'const a = `${root(org, project)}/reports`;';
      expect(scanParams('src/api/platform.ts', endpoint)).toEqual([]);
      expect(scanParams('api/platform.ts', endpoint)).toEqual([]);
      expect(scanParams('../api/platform.ts', endpoint)).toEqual([]);
      expect(scanParams('pages/api/platform.ts', endpoint)).toHaveLength(1);
      expect(scanParams('src/apiary/platform.ts', endpoint)).toHaveLength(1);
      expect(scanParams('src/pages/Reports/ProjPublications.tsx', endpoint)).toHaveLength(1);
    });

    // [utest->req~frontend-retire-reports-no-link~1]
    it('still reports a whole address inside the API client', () => {
      expect(scanParams('src/api/platform.ts', "const a = '/app/acme/demo/reports';")).toHaveLength(1);
    });

    // [utest->req~frontend-retire-reports-no-link~1]
    it('exempts the table of retired addresses, and reports a path without params as before', () => {
      expect(scanParams('routes/retiredRoutes.tsx', "{ path: '/app/:org/:project/reports' }")).toEqual([]);
      expect(retiredAddresses({ 'pages/X.tsx': "const a = '/app/analysis'; const b = `${root}/analysis`;" }, ['/app/analysis'])).toEqual(['pages/X.tsx: /app/analysis']);
    });
  });

  describe('for the library catalogue and the project resources', () => {
    const library = [
      '/app/:org/library', '/app/:org/library/:artifact', '/app/:org/library/:artifact/drafts/:draft',
      '/app/:org/library/:artifact/versions/:version', '/app/:org/:project/library', '/app/:org/:project/resources',
      '/app/:org/:project/resources/:resource',
    ];
    const scanLibrary = (file: string, text: string) => retiredAddresses({ [file]: text }, library);

    // [utest->req~frontend-retire-library-no-link~1]
    it('finds the whole address and the tail written after an interpolation', () => {
      for (const literal of [
        '`/app/${org}/library`', '`/app/${slug}/library/${artifact}`', '`/app/${slug}/library/${a}/versions/${v}`', "'/app/acme/library/a1/drafts/d1'",
        '`/app/${org}/${project}/library`', '`/app/${org}/${project}/resources/${slug}`', '`${root}/resources`', '`${root}/library`',
        '`${root}/resources/${encodeURIComponent(resource.slug)}`', '`${base}/resources`', '`${organizationRoot}/library/${id}`',
      ]) {
        expect(scanLibrary('pages/X.tsx', `const a = ${literal};`), literal).toHaveLength(1);
      }
    });

    // [utest->req~frontend-retire-library-no-link~1]
    it('does not report look-alikes, the addresses that replace the retired ones or the endpoints of the API client', () => {
      const source = [
        "const a = '/app/acme/libraryx';",
        'const b = `${root}/collections`;',
        'const c = `/app/${org}/${project}/files`;',
        'const d = `/app/${slug}`;',
        'const f = `${root}/resourcesx`;',
        "const e = '/v1/library/artifacts';",
        "// '/app/acme/library' in a comment",
      ].join('\n');
      expect(scanLibrary('pages/X.tsx', source)).toEqual([]);
      expect(scanLibrary('src/api/library.ts', 'const a = `${root}/library`;')).toEqual([]);
      expect(scanLibrary('src/api/library.ts', "const a = '/app/acme/library';")).toHaveLength(1);
    });
  });

  const application = Object.fromEntries(
    Object.entries(sources)
      // Vite names the files of this folder `./x` and the others `../…/x`.
      .map(([file, text]) => [file.startsWith('./') ? file.replace('./', 'src/routes/') : file.replace('../', 'src/'), text] as const)
      .filter(([file]) => !file.startsWith('src/test/')),
  );

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('finds none in the application sources, for the paths of the table', () => {
    expect(Object.keys(application).length).toBeGreaterThan(100);
    expect(retiredAddresses(application, RETIRED_ROUTES.map((route) => route.path))).toEqual([]);
  });

  // [utest->req~frontend-retire-reports-no-link~1]
  it('finds none in the application sources, for the report list and the report editor', () => {
    expect(retiredAddresses(application, ['/app/:org/:project/reports', '/app/:org/:project/reports/:report'])).toEqual([]);
  });

  // [utest->req~frontend-retire-library-no-link~1]
  it('finds none in the application sources, for the library catalogue and the project resources', () => {
    const library = RETIRED_ROUTES.filter((route) => route.slice === 3).map((route) => route.path);
    expect(library).toHaveLength(7);
    expect(retiredAddresses(application, library)).toEqual([]);
  });

  // [utest->req~frontend-retire-reports-no-link~1]
  it('keeps the report endpoints of the API client, which no scan may flag', () => {
    expect(application['src/api/platform.ts']).toContain('${root(org, project)}/reports');
    expect(retiredAddresses({ 'src/api/platform.ts': application['src/api/platform.ts'] }, ['/app/:org/:project/reports', '/app/:org/:project/reports/:report'])).toEqual([]);
  });
});
