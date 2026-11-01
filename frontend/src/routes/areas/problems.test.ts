import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { followMoved } from '../followMoved';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';
import { isProblemTabSegment, problemPath, problemsPath } from '../paths/problems';
import { moved as moves } from './problems';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['case-list', '/app/:org/:project/cases'],
  ['case-detail', '/app/:org/:project/cases/:case/:tab?'],
  ['wb-workbench', '/app/:org/:project/workbench'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area problems', () => {
  // [utest->req~frontend-nav-route-areas~1]
  // [utest->req~frontend-nav-problem-page~1]
  it('has 3 screens: the problem page replaces the version, compare and snapshot screens', () => {
    expect(routesByArea.problems).toHaveLength(3);
    expect(routesByArea.problems.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('declares none of the former problem screens', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['case-revision', 'case-compare', 'snap-detail']) expect(ids, id).not.toContain(id);
  });

  // [utest->req~frontend-retire-composer-screen-not-routed~1]
  // [utest->req~frontend-retire-composer-screen-count~1]
  it('declares no composer screen, and keeps the case screens and the workbench', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    const paths = routeDefinitions.map((definition) => definition.path);
    expect(ids).not.toContain('case-composer');
    expect(paths.filter((path) => /\/compose(\/|$)/.test(path))).toEqual([]);
    for (const id of ['case-list', 'case-detail', 'wb-workbench']) expect(ids, id).toContain(id);
    expect(matchRoutes(config, '/app/acme/atlas/cases/flujo/compose')?.at(-1)?.route.id).toBe('case-detail');
  });

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('keeps the case list and the workbench', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['case-list', 'wb-workbench']) expect(ids, id).toContain(id);
  });

  it('has the workbench at the address of the prototype', () => {
    expect(routeDefinitions.find((definition) => definition.id === 'wb-workbench')?.path).toBe('/app/:org/:project/workbench');
  });

  describe('address resolution', () => {
    // [utest->req~frontend-nav-route-areas~1]
    // [utest->req~frontend-nav-problem-page~1]
    it.each([
      ['/app/acme/atlas/workbench', 'wb-workbench'],
      ['/app/acme/atlas/cases', 'case-list'],
      ['/app/acme/atlas/cases/c1', 'case-detail'],
      ['/app/acme/atlas/cases/compare', 'case-detail'],
      ['/app/acme/atlas/cases/c1/runs', 'case-detail'],
      ['/app/acme/atlas/cases/c1/versions', 'case-detail'],
      ['/app/acme/atlas/cases/c1/source', 'case-detail'],
      ['/app/acme/atlas/cases/c1/settings', 'case-detail'],
      ['/app/acme/atlas/cases/c1/revisions/2', null],
      ['/app/acme/atlas/snapshots/s1', null],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path)).toBe(id);
    });
  });
});

describe('the address builders of the problems area', () => {
  const root = '/app/acme/atlas';

  // [utest->req~frontend-nav-problem-page~1]
  it('names the tab segments of the problem page', () => {
    for (const segment of ['runs', 'versions', 'source', 'settings']) expect(isProblemTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'history', 'compare', '']) expect(isProblemTabSegment(segment), segment).toBe(false);
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('builds the list, the problem, its tab and the version or pair it shows', () => {
    expect(problemsPath(root)).toBe('/app/acme/atlas/cases');
    expect(problemPath(root, 'routing')).toBe('/app/acme/atlas/cases/routing');
    expect(problemPath(root, 'routing', 'source', { version: 2 })).toBe('/app/acme/atlas/cases/routing/source?version=2');
    expect(problemPath(root, 'routing', 'versions', { from: 1, to: 3 })).toBe('/app/acme/atlas/cases/routing/versions?from=1&to=3');
    expect(problemPath(root, 'routing', undefined, { version: '' })).toBe('/app/acme/atlas/cases/routing');
    expect(problemPath(root, 'a b/c', undefined, { version: 'sha256-x' })).toBe('/app/acme/atlas/cases/a%20b%2Fc?version=sha256-x');
  });
});

describe('the moved addresses of the problems area', () => {
  const params = { org: 'acme', project: 'atlas', case: 'routing', revision: '2', snapshot: '0b6c2f' };
  const entry = (path: string) => moves.find((route) => route.path === path);
  const target = (path: string, search = '') => entry(path)?.target(new URLSearchParams(search), params);
  const REVISION = '/app/:org/:project/cases/:case/revisions/:revision';
  const COMPARE = '/app/:org/:project/cases/:case/compare';
  const SNAPSHOT = '/app/:org/:project/snapshots/:snapshot';

  // [utest->req~frontend-nav-problem-page~1]
  it('declares the version, compare and snapshot addresses, with ids of their own', () => {
    expect(moves.map((route) => route.path)).toEqual([REVISION, COMPARE, SNAPSHOT]);
    const screens = routeDefinitions.map((definition) => definition.id);
    for (const route of moves) {
      expect(screens).not.toContain(route.id);
      expect(movedRoutes).toContain(route);
    }
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('marks the version and snapshot addresses permanent, because the gateway links to them, and compare not', () => {
    expect(entry(REVISION)?.permanent).toBe(true);
    expect(entry(SNAPSHOT)?.permanent).toBe(true);
    expect(entry(COMPARE)?.permanent).toBeUndefined();
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('moves a version to the Overview of the problem showing it, and drops the old query', () => {
    expect(target(REVISION)).toBe('/app/acme/atlas/cases/routing?version=2');
    expect(target(REVISION, 'x=1')).toBe('/app/acme/atlas/cases/routing?version=2');
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('moves the comparison to the Versions tab and keeps the pair', () => {
    expect(target(COMPARE)).toBe('/app/acme/atlas/cases/routing/versions');
    expect(target(COMPARE, 'from=1&to=3')).toBe('/app/acme/atlas/cases/routing/versions?from=1&to=3');
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('moves a snapshot to the problems of the project, without the snapshot', () => {
    expect(target(SNAPSHOT)).toBe('/app/acme/atlas/cases');
    expect(target(SNAPSHOT, 'x=1')).toBe('/app/acme/atlas/cases');
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('encodes the segments', () => {
    const odd = { org: 'a b', project: 'p/q', case: 'c#1', revision: 'sha256-é', snapshot: 's' };
    expect(entry(REVISION)?.target(new URLSearchParams(), odd)).toBe('/app/a%20b/p%2Fq/cases/c%231?version=sha256-%C3%A9');
  });

  // [utest->req~frontend-nav-problem-page~1]
  it('ends on the problem page and the list: the addresses settle on a screen in one hop', () => {
    for (const [old, expected, screen] of [
      ['/app/acme/atlas/cases/routing/revisions/2', '/app/acme/atlas/cases/routing?version=2', 'case-detail'],
      ['/app/acme/atlas/cases/routing/compare?from=1&to=3', '/app/acme/atlas/cases/routing/versions?from=1&to=3', 'case-detail'],
      ['/app/acme/atlas/snapshots/0b6c2f', '/app/acme/atlas/cases', 'case-list'],
    ]) {
      const settled = followMoved(old, routeDefinitions, movedRoutes);
      expect(settled).toBe(expected);
      expect(resolve(settled.split('?')[0])).toBe(screen);
    }
  });
});
