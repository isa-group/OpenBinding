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
  // [utest->req~frontend-nav-route-areas~1]
  it('has one area test for each area of the registry, and nothing else', () => {
    expect(Object.keys(expectations).sort()).toEqual(Object.keys(routesByArea).sort());
  });

  // [utest->req~frontend-nav-screen-budget~1]
  // [utest->req~frontend-retire-screen-count~1]
  // [utest->req~frontend-retire-reports-screen-count~1]
  // [utest->req~frontend-retire-library-screen-count~1]
  // [utest->req~frontend-retire-composer-screen-count~1]
  // [utest->req~frontend-retire-sponsorship-screen-count~1]
  it('registers as many screens as the area tests expect, each one of them', () => {
    const expected = Object.values(expectations).flat();
    expect(expected.length).toBeGreaterThan(0);
    expect(routeDefinitions).toHaveLength(expected.length);
    expect(routeDefinitions.map((definition) => definition.id).sort()).toEqual(expected.map(([id]) => id).sort());
  });

  // [utest->req~frontend-nav-screen-budget~1]
  it('keeps every area at the size its test expects', () => {
    for (const [area, expected] of Object.entries(expectations)) {
      expect(routesByArea[area as keyof typeof routesByArea], area).toHaveLength(expected.length);
    }
  });

  // [utest->req~frontend-nav-screen-budget~1]
  it.todo('has at most 45 screens');
});
