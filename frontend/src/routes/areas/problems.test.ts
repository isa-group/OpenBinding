import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { followMoved } from '../followMoved';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';
import { RETIRED_ROUTES } from '../retiredRoutes';
import { isProblemTabSegment, PROBLEMS_SEGMENT, problemPath, problemsPath } from '../paths/problems';
import { moved as moves } from './problems';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['case-list', '/app/:org/:project/problems'],
  ['case-detail', '/app/:org/:project/problems/:case/:tab?'],
  ['wb-workbench', '/app/:org/:project/workbench'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area problems', () => {
  it('has 3 screens: the problem page replaces the version, compare and snapshot screens', () => {
    expect(routesByArea.problems).toHaveLength(3);
    expect(routesByArea.problems.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('routes no path with a cases segment, and routes the problem addresses', () => {
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(paths.filter((path) => path.split('/').includes('cases'))).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining(['/app/:org/:project/problems', '/app/:org/:project/problems/:case/:tab?']));
  });

  it('declares none of the former problem screens', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['case-revision', 'case-compare', 'snap-detail']) expect(ids, id).not.toContain(id);
  });

  it('declares no composer screen, and keeps the case screens and the workbench', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(ids).not.toContain('case-composer');
    expect(paths.filter((path) => /\/compose(\/|$)/.test(path))).toEqual([]);
    for (const id of ['case-list', 'case-detail', 'wb-workbench']) expect(ids, id).toContain(id);
    expect(matchRoutes(config, '/app/acme/atlas/problems/flujo/compose')?.at(-1)?.route.id).toBe('case-detail');
  });

  it('keeps the case list and the workbench', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['case-list', 'wb-workbench']) expect(ids, id).toContain(id);
  });

  it('has the workbench at the address of the prototype', () => {
    expect(routeDefinitions.find((definition) => definition.id === 'wb-workbench')?.path).toBe('/app/:org/:project/workbench');
  });

  describe('address resolution', () => {
    it.each([
      ['/app/acme/atlas/workbench', 'wb-workbench'],
      ['/app/acme/atlas/problems', 'case-list'],
      ['/app/acme/atlas/problems/c1', 'case-detail'],
      ['/app/acme/atlas/problems/compare', 'case-detail'],
      ['/app/acme/atlas/problems/c1/runs', 'case-detail'],
      ['/app/acme/atlas/problems/c1/versions', 'case-detail'],
      ['/app/acme/atlas/problems/c1/source', 'case-detail'],
      ['/app/acme/atlas/problems/c1/settings', 'case-detail'],
      ['/app/acme/atlas/problems/c1/revisions/2', null],
      ['/app/acme/atlas/cases', null],
      ['/app/acme/atlas/cases/c1', null],
      ['/app/acme/atlas/cases/c1/runs', null],
      ['/app/acme/atlas/snapshots/s1', null],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path)).toBe(id);
    });
  });
});

describe('the address builders of the problems area', () => {
  const root = '/app/acme/atlas';

  it('names the tab segments of the problem page', () => {
    for (const segment of ['runs', 'versions', 'source', 'settings']) expect(isProblemTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'history', 'compare', '']) expect(isProblemTabSegment(segment), segment).toBe(false);
  });

  it('builds the list, the problem, its tab and the version or pair it shows', () => {
    expect(problemsPath(root)).toBe('/app/acme/atlas/problems');
    expect(problemPath(root, 'routing')).toBe('/app/acme/atlas/problems/routing');
    expect(problemPath(root, 'routing', 'source', { version: 2 })).toBe('/app/acme/atlas/problems/routing/source?version=2');
    expect(problemPath(root, 'routing', 'versions', { from: 1, to: 3 })).toBe('/app/acme/atlas/problems/routing/versions?from=1&to=3');
    expect(problemPath(root, 'routing', undefined, { version: '' })).toBe('/app/acme/atlas/problems/routing');
    expect(problemPath(root, 'a b/c', undefined, { version: 'sha256-x' })).toBe('/app/acme/atlas/problems/a%20b%2Fc?version=sha256-x');
  });

  it('names the segment once', () => {
    expect(PROBLEMS_SEGMENT).toBe('problems');
  });
});

describe('the moved addresses of the problems area', () => {
  const params = { org: 'acme', project: 'atlas', case: 'routing', revision: '2', snapshot: '0b6c2f' };
  const entry = (path: string) => moves.find((route) => route.path === path);
  const target = (path: string, search = '') => entry(path)?.target(new URLSearchParams(search), params);
  const LIST = '/app/:org/:project/cases';
  const PROBLEM = '/app/:org/:project/cases/:case';
  const TAB = '/app/:org/:project/cases/:case/:tab';
  const REVISION = '/app/:org/:project/cases/:case/revisions/:revision';
  const COMPARE = '/app/:org/:project/cases/:case/compare';
  const SNAPSHOT = '/app/:org/:project/snapshots/:snapshot';

  it('declares the list, problem, tab, version, compare and snapshot addresses, with ids of their own', () => {
    expect(moves.map((route) => route.path)).toEqual([LIST, PROBLEM, TAB, REVISION, COMPARE, SNAPSHOT]);
    expect(moves.map((route) => route.id)).toEqual([
      'case-list-moved', 'case-moved', 'case-tab-moved', 'case-revision-moved', 'case-compare-moved', 'snap-detail-moved',
    ]);
    const screens = routeDefinitions.map((definition) => definition.id);
    for (const route of moves) {
      expect(screens).not.toContain(route.id);
      expect(movedRoutes).toContain(route);
    }
  });

  it('marks the version and snapshot addresses permanent, because the gateway links to them, and compare not', () => {
    expect(entry(REVISION)?.permanent).toBe(true);
    expect(entry(SNAPSHOT)?.permanent).toBe(true);
    expect(entry(COMPARE)?.permanent).toBeUndefined();
    for (const path of [LIST, PROBLEM, TAB]) expect(entry(path)?.permanent, path).toBeUndefined();
  });

  it('moves the list, a problem and its tab to /problems, keeping the tab, the query and the hash', () => {
    expect(target(LIST)).toBe('/app/acme/atlas/problems');
    expect(target(LIST, 'create=problem')).toBe('/app/acme/atlas/problems?create=problem');
    expect(target(PROBLEM)).toBe('/app/acme/atlas/problems/routing');
    expect(target(PROBLEM, 'version=2')).toBe('/app/acme/atlas/problems/routing?version=2');
    expect(entry(TAB)?.target(new URLSearchParams('version=2'), { ...params, tab: 'source' })).toBe('/app/acme/atlas/problems/routing/source?version=2');
    expect(followMoved('/app/acme/atlas/cases/routing/runs?x=1#top', routeDefinitions, movedRoutes)).toBe('/app/acme/atlas/problems/routing/runs?x=1#top');
  });

  it('lets the static version, compare and composer addresses win over the tab entry, each in one hop', () => {
    const table = [...routeDefinitions, ...RETIRED_ROUTES].map(({ id, path }) => ({ id, path }));
    const config = [...table, ...movedRoutes.map((route) => ({ id: `moved:${route.id}`, path: route.path }))];
    const entryOf = (address: string) => matchRoutes(config, address)?.at(-1)?.route.id;
    expect(entryOf('/app/acme/atlas/cases/routing/revisions/2')).toBe('moved:case-revision-moved');
    expect(entryOf('/app/acme/atlas/cases/routing/compare')).toBe('moved:case-compare-moved');
    expect(entryOf('/app/acme/atlas/cases/routing/compose')).toBe('case-composer');
    expect(entryOf('/app/acme/atlas/cases/routing/runs')).toBe('moved:case-tab-moved');
    expect(entryOf('/app/acme/atlas/cases/routing')).toBe('moved:case-moved');
    expect(entryOf('/app/acme/atlas/cases')).toBe('moved:case-list-moved');
  });

  it('moves a version to the Overview of the problem showing it, and drops the old query', () => {
    expect(target(REVISION)).toBe('/app/acme/atlas/problems/routing?version=2');
    expect(target(REVISION, 'x=1')).toBe('/app/acme/atlas/problems/routing?version=2');
  });

  it('moves the comparison to the Versions tab and keeps the pair', () => {
    expect(target(COMPARE)).toBe('/app/acme/atlas/problems/routing/versions');
    expect(target(COMPARE, 'from=1&to=3')).toBe('/app/acme/atlas/problems/routing/versions?from=1&to=3');
  });

  it('moves a snapshot to the problems of the project, without the snapshot', () => {
    expect(target(SNAPSHOT)).toBe('/app/acme/atlas/problems');
    expect(target(SNAPSHOT, 'x=1')).toBe('/app/acme/atlas/problems');
  });

  it('encodes the segments', () => {
    const odd = { org: 'a b', project: 'p/q', case: 'c#1', revision: 'sha256-é', snapshot: 's' };
    expect(entry(REVISION)?.target(new URLSearchParams(), odd)).toBe('/app/a%20b/p%2Fq/problems/c%231?version=sha256-%C3%A9');
    expect(entry(PROBLEM)?.target(new URLSearchParams(), odd)).toBe('/app/a%20b/p%2Fq/problems/c%231');
  });

  it('ends on the problem page and the list: the addresses settle on a screen in one hop', () => {
    for (const [old, expected, screen] of [
      ['/app/acme/atlas/cases/routing/revisions/2', '/app/acme/atlas/problems/routing?version=2', 'case-detail'],
      ['/app/acme/atlas/cases/routing/compare?from=1&to=3', '/app/acme/atlas/problems/routing/versions?from=1&to=3', 'case-detail'],
      ['/app/acme/atlas/snapshots/0b6c2f', '/app/acme/atlas/problems', 'case-list'],
      ['/app/acme/atlas/cases', '/app/acme/atlas/problems', 'case-list'],
      ['/app/acme/atlas/cases/routing', '/app/acme/atlas/problems/routing', 'case-detail'],
      ['/app/acme/atlas/cases/routing/source?version=2', '/app/acme/atlas/problems/routing/source?version=2', 'case-detail'],
    ]) {
      const settled = followMoved(old, routeDefinitions, movedRoutes);
      expect(settled).toBe(expected);
      expect(resolve(settled.split('?')[0])).toBe(screen);
    }
  });
});
