import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';
import { isProblemTabSegment, PROBLEMS_SEGMENT, problemPath, problemsPath, workbenchPath } from '../paths/problems';
import { launchPath, runPath, runsPath } from '../paths/runs';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['case-list', '/app/:org/problems'],
  ['case-detail', '/app/:org/problems/:case/:tab?'],
  ['wb-workbench', '/app/:org/workbench'],
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
    expect(paths).toEqual(expect.arrayContaining(['/app/:org/problems', '/app/:org/problems/:case/:tab?']));
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
    expect(matchRoutes(config, '/app/acme/problems/flujo/compose')?.at(-1)?.route.id).toBe('case-detail');
  });

  it('keeps the case list and the workbench', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['case-list', 'wb-workbench']) expect(ids, id).toContain(id);
  });

  it('has the workbench at the organization', () => {
    expect(routeDefinitions.find((definition) => definition.id === 'wb-workbench')?.path).toBe('/app/:org/workbench');
  });

  describe('address resolution', () => {
    it.each([
      ['/app/acme/workbench', 'wb-workbench'],
      ['/app/acme/problems', 'case-list'],
      ['/app/acme/problems/c1', 'case-detail'],
      ['/app/acme/problems/compare', 'case-detail'],
      ['/app/acme/problems/c1/runs', 'case-detail'],
      ['/app/acme/problems/c1/versions', 'case-detail'],
      ['/app/acme/problems/c1/source', 'case-detail'],
      ['/app/acme/problems/c1/settings', 'case-detail'],
      ['/app/acme/problems/c1/revisions/2', null],
      ['/app/acme/atlas/problems', null],
      ['/app/acme/atlas/workbench', null],
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

  it('names the tab segments of the problem page', () => {
    for (const segment of ['runs', 'versions', 'source', 'settings']) expect(isProblemTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'history', 'compare', '']) expect(isProblemTabSegment(segment), segment).toBe(false);
  });

  it('builds the list, the problem, its tab and the version or pair it shows', () => {
    expect(problemsPath('acme')).toBe('/app/acme/problems');
    expect(problemPath('acme', 'routing')).toBe('/app/acme/problems/routing');
    expect(problemPath('acme', 'routing', 'source', { version: 2 })).toBe('/app/acme/problems/routing/source?version=2');
    expect(problemPath('acme', 'routing', 'versions', { from: 1, to: 3 })).toBe('/app/acme/problems/routing/versions?from=1&to=3');
    expect(problemPath('acme', 'routing', undefined, { version: '' })).toBe('/app/acme/problems/routing');
    expect(problemPath('acme', 'a b/c', undefined, { version: 'sha256-x' })).toBe('/app/acme/problems/a%20b%2Fc?version=sha256-x');
  });

  it('builds the Workbench of the organization and what it opens', () => {
    expect(workbenchPath('acme')).toBe('/app/acme/workbench');
    expect(workbenchPath('acme', { problem: 'routing', revision: 2 })).toBe('/app/acme/workbench?problem=routing&revision=2');
    expect(workbenchPath('acme', { template: 'demo/01_simple_seq' })).toBe('/app/acme/workbench?template=demo%2F01_simple_seq');
  });

  it('builds the runs of the organization and the launcher of a run of a problem version or with an engine', () => {
    expect(runsPath('acme')).toBe('/app/acme/runs');
    expect(runPath('acme', 'r 1')).toBe('/app/acme/runs/r%201');
    expect(launchPath('acme', { problem: 'routing', revision: 2 })).toBe('/app/acme/runs/new?problem=routing&revision=2');
    expect(launchPath('acme', { engine: 'bim.builtin/random-search' })).toBe('/app/acme/runs/new?engine=bim.builtin%2Frandom-search');
    expect(launchPath('acme')).toBe('/app/acme/runs/new');
  });

  it('names the segment once', () => {
    expect(PROBLEMS_SEGMENT).toBe('problems');
  });
});
