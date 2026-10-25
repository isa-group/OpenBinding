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

// [impl->req~frontend-retire-no-link-to-retired~1]
/**
 * `<file>: <literal>` for every string or template literal of the sources that starts with a retired path followed by the end,
 * `/`, `?`, `#` or `${`. The file `routes/retiredRoutes.tsx` (and no other) is exempt. Known limit: an address built from pieces is not seen.
 */
export function retiredAddresses(sources: Record<string, string>, retiredPaths: readonly string[]): string[] {
  const hits: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (file.replace(/^(\.\.\/|src\/)/, '') === 'routes/retiredRoutes.tsx') continue;
    for (const literal of literalsOf(text)) {
      const retired = retiredPaths.some((path) => {
        if (!literal.startsWith(path)) return false;
        const rest = literal.slice(path.length);
        return rest === '' || /^[/?#]/.test(rest) || rest.startsWith('${');
      });
      if (retired) hits.push(`${file}: ${literal}`);
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
    const retired = /^\/(playground|profiles|schemas|team|research|funding|contributions|changelog)(\/|$)|^\/app\/analysis\?job=|^\/app\/[^/]+\/[^/]+\/(verifier|analytics|artifacts)(\/|$)/;
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

  // [utest->req~frontend-retire-no-link-to-retired~1]
  it('finds none in the application sources, for the paths of the table', () => {
    const application = Object.fromEntries(
      Object.entries(sources)
        // Vite names the files of this folder `./x` and the others `../…/x`.
        .map(([file, text]) => [file.startsWith('./') ? file.replace('./', 'src/routes/') : file.replace('../', 'src/'), text] as const)
        .filter(([file]) => !file.startsWith('src/test/')),
    );
    expect(Object.keys(application).length).toBeGreaterThan(100);
    expect(retiredAddresses(application, RETIRED_ROUTES.map((route) => route.path))).toEqual([]);
  });
});
