import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';
import {
  isProblemTabSegment,
  PROBLEMS_SEGMENT,
  problemPath,
  problemsPath,
  problemEditorPath,
} from '../paths/problems';
import { launchPath, runPath, runsPath } from '../paths/runs';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['problem-list', '/app/:org/problems'],
  ['problem-detail', '/app/:org/problems/:case/:tab?'],
  ['problem-editor', '/app/:org/problem-editor'],
];

const config = routeDefinitions.map(definition => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area problems', () => {
  it('has 3 screens: the problem page replaces the version, compare and snapshot screens', () => {
    expect(routesByArea.problems).toHaveLength(3);
    expect(routesByArea.problems.map(definition => [definition.id, definition.path])).toEqual(
      PROTOTYPE
    );
  });

  it('routes no path with a cases segment, and routes the problem addresses', () => {
    const paths = routeDefinitions.map(definition => definition.path);
    expect(paths.filter(path => path.split('/').includes('cases'))).toEqual([]);
    expect(paths).toEqual(
      expect.arrayContaining(['/app/:org/problems', '/app/:org/problems/:case/:tab?'])
    );
  });

  it('declares none of the former problem screens', () => {
    const ids = routeDefinitions.map(definition => definition.id);
    for (const id of ['case-revision', 'case-compare', 'snap-detail'])
      expect(ids, id).not.toContain(id);
  });

  it('declares no composer screen, and keeps the problem screens and the problem editor', () => {
    const ids = routeDefinitions.map(definition => definition.id);
    const paths = routeDefinitions.map(definition => definition.path);
    expect(ids).not.toContain('case-composer');
    expect(paths.filter(path => /\/compose(\/|$)/.test(path))).toEqual([]);
    for (const id of ['problem-list', 'problem-detail', 'problem-editor'])
      expect(ids, id).toContain(id);
    expect(matchRoutes(config, '/app/acme/problems/flujo/compose')?.at(-1)?.route.id).toBe(
      'problem-detail'
    );
  });

  it('keeps the problem list and the problem editor', () => {
    const ids = routeDefinitions.map(definition => definition.id);
    for (const id of ['problem-list', 'problem-editor']) expect(ids, id).toContain(id);
  });

  it('has the problem editor at the organization', () => {
    expect(routeDefinitions.find(definition => definition.id === 'problem-editor')?.path).toBe(
      '/app/:org/problem-editor'
    );
  });

  describe('address resolution', () => {
    it.each([
      ['/app/acme/problem-editor', 'problem-editor'],
      ['/app/acme/problems', 'problem-list'],
      ['/app/acme/problems/c1', 'problem-detail'],
      ['/app/acme/problems/compare', 'problem-detail'],
      ['/app/acme/problems/c1/runs', 'problem-detail'],
      ['/app/acme/problems/c1/versions', 'problem-detail'],
      ['/app/acme/problems/c1/source', 'problem-detail'],
      ['/app/acme/problems/c1/settings', 'problem-detail'],
      ['/app/acme/problems/c1/revisions/2', null],
      ['/app/acme/atlas/problems', null],
      ['/app/acme/atlas/problem-editor', null],
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
    for (const segment of ['candidates', 'versions', 'runs', 'compositions', 'source', 'settings'])
      expect(isProblemTabSegment(segment), segment).toBe(true);
    for (const segment of ['overview', 'history', 'compare', ''])
      expect(isProblemTabSegment(segment), segment).toBe(false);
  });

  it('builds the list, the problem, its tab and the version or pair it shows', () => {
    expect(problemsPath('acme')).toBe('/app/acme/problems');
    expect(problemsPath('acme', { origin: 'editor', composition: 'fleet routing' })).toBe(
      '/app/acme/problems?origin=editor&composition=fleet+routing'
    );
    expect(
      problemPath('acme', 'routing', 'candidates', {
        version: 1,
        composition: 'fleet',
        compositionVersion: '1.2.0',
      })
    ).toBe(
      '/app/acme/problems/routing/candidates?version=1&composition=fleet&compositionVersion=1.2.0'
    );
    expect(problemPath('acme', 'routing')).toBe('/app/acme/problems/routing');
    expect(problemPath('acme', 'routing', 'source', { version: 2 })).toBe(
      '/app/acme/problems/routing/source?version=2'
    );
    expect(problemPath('acme', 'routing', 'versions', { from: 1, to: 3 })).toBe(
      '/app/acme/problems/routing/versions?from=1&to=3'
    );
    expect(problemPath('acme', 'routing', undefined, { version: '' })).toBe(
      '/app/acme/problems/routing'
    );
    expect(problemPath('acme', 'a b/c', undefined, { version: 'sha256-x' })).toBe(
      '/app/acme/problems/a%20b%2Fc?version=sha256-x'
    );
  });

  it('builds the problem editor of the organization, what it opens and what it highlights', () => {
    expect(problemEditorPath('acme')).toBe('/app/acme/problem-editor');
    expect(problemEditorPath('acme', { problem: 'routing', revision: 2 })).toBe(
      '/app/acme/problem-editor?problem=routing&revision=2'
    );
    expect(problemEditorPath('acme', { template: 'demo/01_simple_seq' })).toBe(
      '/app/acme/problem-editor?template=demo%2F01_simple_seq'
    );
    expect(
      problemEditorPath('acme', {
        problem: 'routing',
        revision: 2,
        composition: 'checkout',
        compositionVersion: '1.1.0',
      })
    ).toBe(
      '/app/acme/problem-editor?problem=routing&revision=2&composition=checkout&compositionVersion=1.1.0'
    );
  });

  it('builds the runs of the organization and the launcher of a run of a problem version or with an engine', () => {
    expect(runsPath('acme')).toBe('/app/acme/runs');
    expect(runPath('acme', 'r 1')).toBe('/app/acme/runs/r%201');
    expect(launchPath('acme', { problem: 'routing', revision: 2 })).toBe(
      '/app/acme/runs/new?problem=routing&revision=2'
    );
    expect(launchPath('acme', { engine: 'bim.builtin/random-search' })).toBe(
      '/app/acme/runs/new?engine=bim.builtin%2Frandom-search'
    );
    expect(launchPath('acme', { problem: 'routing', revision: 2, preset: 'fast-sampling' })).toBe(
      '/app/acme/runs/new?problem=routing&revision=2&preset=fast-sampling'
    );
    expect(launchPath('acme')).toBe('/app/acme/runs/new');
  });

  it('names the segment once', () => {
    expect(PROBLEMS_SEGMENT).toBe('problems');
  });
});
