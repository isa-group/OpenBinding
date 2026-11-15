import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea, type AreaName } from './registry';

// Resolution across the areas. Addresses where a fixed segment meets a `:param` segment are the ones a reordering of the registry could
// change, and the registry order decides ties of rank. This file names no screen: it asserts the AREA of the screen an address
// resolves to, and what the address of each screen of an area resolves to is checked in that area's own test (areas/<area>.test.ts),
// so a change to the screens of one area edits only that area's files.
const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const areaOfScreen = new Map(Object.entries(routesByArea).flatMap(([area, screens]) => screens.map((screen) => [screen.id, area as AreaName] as const)));

const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;
/** The area of the screen an address resolves to, `null` when it resolves to none. */
const areaAt = (path: string) => {
  const id = resolve(path);
  return id === null ? null : areaOfScreen.get(id) ?? null;
};

/** An address the path leads to: an optional segment dropped, the organization of the examples, any other parameter filled. */
const example = (path: string) => path
  .replace(/\/:[A-Za-z]+\?/g, '')
  .replace(':org', 'acme')
  .replace(/:[A-Za-z]+/g, 'sample') || '/';

describe('address resolution across the registry', () => {
  it('knows the area of every screen', () => {
    expect(areaOfScreen.size).toBe(routeDefinitions.length);
  });

  it.each(Object.keys(routesByArea) as AreaName[])('serves the address of every screen of area %s by a screen of the same area', (area) => {
    for (const screen of routesByArea[area]) {
      expect(areaAt(example(screen.path)), `${screen.id} ${screen.path}`).toBe(area);
    }
  });

  // A fixed segment under /app (`/app/account`, `/app/admin`, …) is the first segment of a screen of some area. An address one level below
  // it that no screen of that area claims resolves to no screen (there are no projects to read it as), or to a screen of the area itself
  // when the area takes any section there.
  const fixedSegments = [...new Set(routeDefinitions.flatMap((definition) => {
    const [, root, first] = definition.path.split('/');
    return root === 'app' && first && !first.startsWith(':') ? [first] : [];
  }))];

  it('finds fixed segments under /app', () => {
    expect(fixedSegments).toEqual(expect.arrayContaining(['account', 'admin', 'engines']));
  });

  it.each(fixedSegments)('reads an unknown address below /app/%s as no screen, or as a screen of its own area', (segment) => {
    const owners = new Set(routeDefinitions.filter((definition) => definition.path.split('/')[2] === segment).map((definition) => areaOfScreen.get(definition.id)));
    expect(areaAt('/app/zz-organization/zz-unknown')).toBeNull();
    const area = areaAt(`/app/${segment}/zz-unknown`);
    expect(area === null || owners.has(area), `/app/${segment}/zz-unknown -> ${area}`).toBe(true);
  });

  it.each([
    ['/', 'public'],
    ['/app', 'organizations'],
    ['/app/acme', 'organizations'],
    ['/app/acme/settings', 'organizations'],
    ['/app/settings/settings', 'organizations'],
    // Projects are gone: an organization has only its own sections, and the old creation addresses lead nowhere.
    ['/app/acme/new-project', null],
    ['/app/organizations/new', null],
    ['/app/acme/atlas', null],
    ['/app/acme/atlas/settings', null],
  ] as const)('%s -> the area %s', (path, area) => {
    expect(areaAt(path)).toBe(area);
  });

  it('has no screen called org-create, proj-create or any proj-*', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('org-create');
    expect(ids).not.toContain('proj-create');
    expect(ids.filter((id) => id.startsWith('proj-'))).toEqual([]);
    expect(routeDefinitions.filter((definition) => definition.path.includes(':project'))).toEqual([]);
  });

  it.each([
    // Engines are only addressed by namespace, name and version.
    '/engines/new',
    // Below an organization, only the sections of the screens are routed.
    '/app/acme/zz-no-such-section',
    '/app/acme/zz-no-such-section/zz',
  ])('resolves %s to no screen', (path) => {
    expect(resolve(path)).toBeNull();
  });
});
