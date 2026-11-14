import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from './registry';

/** The source of every area test, as text: importing them would run their tests a second time. */
const areaTests = import.meta.glob<string>('./areas/*.test.ts', { query: '?raw', import: 'default', eager: true });

/** The `['id', '/path'],` lines each area test lists as the screens it expects (one pair per line). */
const PAIR = /^\s*\['([a-z0-9-]+)',\s*'(\/[^']*)'\],?\s*$/gm;

const expectedOf = (source: string) => [...source.matchAll(PAIR)].map((match) => [match[1], match[2]]);

const expectations = Object.fromEntries(
  Object.entries(areaTests).map(([file, source]) => [file.replace(/^\.\/areas\/(.+)\.test\.ts$/, '$1'), expectedOf(source)]),
);

describe('screen budget', () => {
  it('has one area test for each area of the registry, and nothing else', () => {
    expect(Object.keys(expectations).sort()).toEqual(Object.keys(routesByArea).sort());
  });

  it('registers as many screens as the area tests expect, each one of them', () => {
    const expected = Object.values(expectations).flat();
    expect(expected.length).toBeGreaterThan(0);
    expect(routeDefinitions).toHaveLength(expected.length);
    expect(routeDefinitions.map((definition) => definition.id).sort()).toEqual(expected.map(([id]) => id).sort());
  });

  it('keeps every area at the size its test expects', () => {
    for (const [area, expected] of Object.entries(expectations)) {
      expect(routesByArea[area as keyof typeof routesByArea], area).toHaveLength(expected.length);
    }
  });

  it('has at most 35 screens', () => {
    expect(routeDefinitions.length, `${routeDefinitions.length} screens against a ceiling of 35`).toBeLessThanOrEqual(35);
  });

  // `pub-workbench` is registered in the public area (public 4, problems 3).
  it('has the area sizes of the registry, 34 screens in all', () => {
    const sizes = Object.fromEntries(Object.entries(routesByArea).map(([area, routes]) => [area, routes.length]));
    expect(sizes).toEqual({
      public: 4,
      auth: 5,
      engines: 5,
      account: 1,
      organizations: 3,
      project: 2,
      problems: 3,
      runs: 4,
      studies: 3,
      admin: 4,
    });
    expect(routeDefinitions).toHaveLength(34);
  });

  it('keeps no per-domain route file and no mention of routesByDomain under routes/', () => {
    const files = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const paths = Object.keys(files);
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter((path) => /^\.\/d[1-8]\.tsx$/.test(path))).toEqual([]);
    // This file names the identifier to forbid it; every other file must not.
    expect(paths.filter((path) => !path.endsWith('screenBudget.test.ts') && files[path].includes('routesByDomain'))).toEqual([]);
  });

  it('reports an id registered in two areas, naming both', () => {
    const duplicates = (areas: Record<string, readonly { id: string }[]>): string[] => {
      const seen = new Map<string, string>();
      const found: string[] = [];
      for (const [area, routes] of Object.entries(areas)) {
        for (const { id } of routes) {
          const first = seen.get(id);
          if (first !== undefined) found.push(`${id}: ${first}, ${area}`);
          else seen.set(id, area);
        }
      }
      return found;
    };
    expect(duplicates({ public: [{ id: 'a' }, { id: 'b' }], runs: [{ id: 'b' }, { id: 'c' }] })).toEqual(['b: public, runs']);
    expect(duplicates(routesByArea)).toEqual([]);
  });
});
