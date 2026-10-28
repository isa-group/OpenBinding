import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea, type AreaName } from './registry';

// [utest->req~frontend-nav-route-areas~1]
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

/** An address the path leads to: an optional segment dropped, the organization and project of the examples, any other parameter filled. */
const example = (path: string) => path
  .replace(/\/:[A-Za-z]+\?/g, '')
  .replace(':org', 'acme')
  .replace(':project', 'atlas')
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

  // A fixed segment under /app (`/app/jobs`, `/app/account`, …) is the first segment of a screen of some area. An address one level below
  // it that no screen of that area claims is read as an organization and a project: the screen of the plain `/app/:org/:project` address,
  // or a screen of the area itself when the area takes any section there.
  const fixedSegments = [...new Set(routeDefinitions.flatMap((definition) => {
    const [, root, first] = definition.path.split('/');
    return root === 'app' && first && !first.startsWith(':') ? [first] : [];
  }))];

  it('finds fixed segments under /app', () => {
    expect(fixedSegments.length).toBeGreaterThan(3);
  });

  it.each(fixedSegments)('reads an unknown address below /app/%s as an organization and a project, or as a screen of its own area', (segment) => {
    const owners = new Set(routeDefinitions.filter((definition) => definition.path.split('/')[2] === segment).map((definition) => areaOfScreen.get(definition.id)));
    const fallback = areaAt('/app/zz-organization/zz-project');
    expect(fallback).not.toBeNull();
    const area = areaAt(`/app/${segment}/zz-unknown`);
    expect(area === null ? 'no screen' : [fallback, ...owners].includes(area), `/app/${segment}/zz-unknown -> ${area}`).toBe(true);
  });

  it.each([
    ['/', 'public'],
    ['/app', 'organizations'],
    ['/app/acme', 'organizations'],
    // The fixed `settings` segment wins over a project called `settings`.
    ['/app/acme/settings', 'organizations'],
    ['/app/settings/settings', 'organizations'],
    // A project called `new-project` is the project area either way.
    ['/app/acme/new-project', 'project'],
    ['/app/new-project/new-project', 'project'],
    ['/app/acme/atlas', 'project'],
  ] as const)('%s -> the area %s', (path, area) => {
    expect(areaAt(path)).toBe(area);
  });

  it.each([
    // Engines are only addressed by namespace, name and version.
    '/engines/new',
    // Below a project, only the sections of the screens are routed.
    '/app/acme/atlas/zz-no-such-section',
    '/app/acme/atlas/zz-no-such-section/zz',
  ])('resolves %s to no screen', (path) => {
    expect(resolve(path)).toBeNull();
  });
});
