import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions } from './registry';

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
