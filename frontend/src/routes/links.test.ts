import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { screens } from './router';

/** The line (from 1) of an offset in a source. */
const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

/** Every source file that is not a test, as text. */
const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * The static internal addresses written in the code: `to="/x"`, `to: '/x'`, `href: '/x'`, `to={`/x/${id}`}`, `navigate('/x')`.
 * Addresses built from a variable first (`${base}/x`) are not static and are left to the tests of their screen.
 */
const LINK =
  /(?:\bto|\bhref|\bfrom)\s*(?:=\s*\{?|:\s*)(['"`])(\/[^'"`]*)\1|\bnavigate\(\s*(['"`])(\/[^'"`]*)\3/g;

/** The screens: a link leads to one of them. */
const config = screens.map(screen => ({ id: screen.id, path: screen.path }));

/** The route an address leads to, with the query, the hash and any `${…}` filled in by an example value. */
const pathOf = (address: string) => address.replace(/\$\{[^}]*\}/g, 'sample').split(/[?#]/)[0];

/** The static links of a source text, each with its address and its line. */
function linksOf(file: string, text: string) {
  return [...text.matchAll(LINK)].map(match => ({
    file,
    line: lineOf(text, match.index ?? 0),
    address: match[2] ?? match[4],
  }));
}

function staticLinks() {
  return Object.entries(sources).flatMap(([file, text]) =>
    linksOf(file.replace('../', 'src/'), text)
  );
}

describe('internal links written in the code', () => {
  it('finds the links to check', () => {
    expect(staticLinks().length).toBeGreaterThan(50);
  });

  it('reads each way of writing a link, with its line', () => {
    const text = ['<Link to="/a/b">', "x({ to: `/c/${id}`, href: '/d' });", 'navigate("/e");'].join(
      '\n'
    );
    expect(linksOf('src/X.tsx', text)).toEqual([
      { file: 'src/X.tsx', line: 1, address: '/a/b' },
      { file: 'src/X.tsx', line: 2, address: '/c/${id}' },
      { file: 'src/X.tsx', line: 2, address: '/d' },
      { file: 'src/X.tsx', line: 3, address: '/e' },
    ]);
  });

  it('resolve to a screen of the route table', () => {
    const lost = staticLinks()
      .filter(({ address }) => !matchRoutes(config, pathOf(address)))
      .map(({ file, line, address }) => `${file}:${line}: ${address}`);
    expect(lost, 'links to an address that no screen answers').toEqual([]);
  });

  it('do not point at the addresses the redesign retired', () => {
    const retired =
      /^\/(playground|profiles|schemas|funding|about)(\/|$)|^\/app\/analysis\?job=|^\/app\/[^/]+\/[^/]+\/(verifier|analytics|artifacts|reports|library|resources)(\/|$)|^\/app\/[^/]+\/library(\/|$)|^\/app\/[^/]+\/[^/]+\/cases\/[^/]+\/compose(\/|$)/;
    const old = staticLinks()
      .filter(({ address }) => retired.test(address))
      .map(({ file, line, address }) => `${file}:${line}: ${address}`);
    expect(old).toEqual([]);
  });
});
