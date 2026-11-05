import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { followMoved } from '../followMoved';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';
import { moved as moves } from './studies';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['study-list', '/app/:org/:project/studies'],
  ['study-builder', '/app/:org/:project/studies/new'],
  ['study-detail', '/app/:org/:project/studies/:study/:tab?'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area studies', () => {
  it('has 3 screens: the study page replaces the run, cell and analytics screens, and nothing is about reports', () => {
    expect(routesByArea.studies).toHaveLength(3);
    expect(routesByArea.studies.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('reads /studies/new as the builder and any other address below /studies as a study with an optional tab', () => {
    expect(resolve('/app/acme/atlas/studies/new')).toBe('study-builder');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds')).toBe('study-detail');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/progress')).toBe('study-detail');
    expect(resolve('/app/acme/atlas/studies/engines-vs-seeds/results')).toBe('study-detail');
  });

  describe('address resolution', () => {
    it.each([
      ['/app/acme/atlas/studies', 'study-list'],
      ['/app/acme/atlas/studies/new', 'study-builder'],
      ['/app/acme/atlas/studies/s1', 'study-detail'],
      ['/app/acme/atlas/studies/s1/setup', 'study-detail'],
      ['/app/acme/atlas/studies/s1/publish', 'study-detail'],
      ['/app/acme/atlas/studies/s1/runs/r1', null],
      ['/app/acme/atlas/studies/s1/runs/r1/cells/c1', null],
      ['/app/acme/atlas/studies/s1/runs/r1/analytics', null],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path)).toBe(id);
    });
  });
});

describe('the moved addresses of the studies area', () => {
  const params = { org: 'acme', project: 'atlas', study: 'engines-vs-seeds', run: 'r1', cell: 'c7' };
  const entry = (path: string) => moves.find((route) => route.path === path);
  const target = (path: string, search = '') => entry(path)?.target(new URLSearchParams(search), params);

  it('declares the three study run addresses, with ids of their own, and none of them permanent', () => {
    expect(moves.map((route) => route.path)).toEqual([
      '/app/:org/:project/studies/:study/runs/:run',
      '/app/:org/:project/studies/:study/runs/:run/analytics',
      '/app/:org/:project/studies/:study/runs/:run/cells/:cell',
    ]);
    const screens = routeDefinitions.map((definition) => definition.id);
    for (const route of moves) {
      expect(screens).not.toContain(route.id);
      expect(movedRoutes).toContain(route);
      expect(route.permanent).toBeUndefined();
      expect(route.keepQuery).toBe(false);
    }
  });

  it('moves the run to Progress, the analytics and a cell to Results, each with the run it named', () => {
    const study = '/app/acme/atlas/studies/engines-vs-seeds';
    expect(target('/app/:org/:project/studies/:study/runs/:run')).toBe(`${study}/progress?run=r1`);
    expect(target('/app/:org/:project/studies/:study/runs/:run/analytics')).toBe(`${study}/results?run=r1`);
    expect(target('/app/:org/:project/studies/:study/runs/:run/cells/:cell')).toBe(`${study}/results?run=r1&cell=c7`);
  });

  it('encodes the segments and drops the query of the old address', () => {
    const odd = { org: 'a b', project: 'p/q', study: 's#t', run: 'r?x', cell: 'c&d' };
    const route = entry('/app/:org/:project/studies/:study/runs/:run/cells/:cell');
    expect(route?.target(new URLSearchParams('x=1'), odd)).toBe('/app/a%20b/p%2Fq/studies/s%23t/results?run=r%3Fx&cell=c%26d');
  });

  it('ends on the study page: the addresses settle on the screen study-detail in one hop', () => {
    for (const [old, expected] of [
      ['/app/acme/atlas/studies/s1/runs/r1', '/app/acme/atlas/studies/s1/progress?run=r1'],
      ['/app/acme/atlas/studies/s1/runs/r1/analytics', '/app/acme/atlas/studies/s1/results?run=r1'],
      ['/app/acme/atlas/studies/s1/runs/r1/cells/c7', '/app/acme/atlas/studies/s1/results?run=r1&cell=c7'],
    ]) {
      const settled = followMoved(old, routeDefinitions, movedRoutes);
      expect(settled).toBe(expected);
      expect(resolve(settled.split('?')[0])).toBe('study-detail');
    }
  });
});
