import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { followMoved } from '../followMoved';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';
import { RUN_HISTORY_PATH, RUNS_SEGMENT } from '../paths/runs';
import { moved as moves } from './runs';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['job-launch', '/app/:org/:project/runs/new'],
  ['job-list', '/app/:org/:project/runs'],
  ['job-detail', '/app/:org/:project/runs/:job'],
  ['job-history', '/app/runs'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

describe('area runs', () => {
  it('has 4 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.runs).toHaveLength(4);
    expect(routesByArea.runs.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('routes no path with a jobs segment, and names the segment once', () => {
    expect(routeDefinitions.map((definition) => definition.path).filter((path) => path.split('/').includes('jobs'))).toEqual([]);
    expect(RUNS_SEGMENT).toBe('runs');
    expect(RUN_HISTORY_PATH).toBe('/app/runs');
  });

  it('keeps the run screens from being read as an organization or project', () => {
    expect(matchRoutes(config, '/app/acme/atlas/runs/new')?.at(-1)?.route.id).toBe('job-launch');
    expect(matchRoutes(config, '/app/runs')?.at(-1)?.route.id).toBe('job-history');
  });

  describe('address resolution', () => {
    it.each([
      ['/app/runs', 'job-history'],
      ['/app/acme/atlas/runs', 'job-list'],
      ['/app/acme/atlas/runs/new', 'job-launch'],
      ['/app/acme/atlas/runs/j1', 'job-detail'],
      ['/app/acme/atlas/jobs', null],
      ['/app/acme/atlas/jobs/new', null],
      ['/app/acme/atlas/jobs/j1', null],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });
  });
});

describe('the moved addresses of the runs area', () => {
  const params = { org: 'acme', project: 'atlas', job: 'j1' };
  const HISTORY = '/app/jobs';
  const LIST = '/app/:org/:project/jobs';
  const LAUNCH = '/app/:org/:project/jobs/new';
  const RUN = '/app/:org/:project/jobs/:job';
  const entry = (path: string) => moves.find((route) => route.path === path);
  const target = (path: string, search = '', given = params) => entry(path)?.target(new URLSearchParams(search), given);

  it('declares the history, list, launcher and run addresses, with ids of their own', () => {
    expect(moves.map((route) => route.path)).toEqual([HISTORY, LIST, LAUNCH, RUN]);
    expect(moves.map((route) => route.id)).toEqual(['job-history-moved', 'job-list-moved', 'job-launch-moved', 'job-moved']);
    const screens = routeDefinitions.map((definition) => definition.id);
    for (const route of moves) {
      expect(screens).not.toContain(route.id);
      expect(movedRoutes).toContain(route);
    }
  });

  it('moves each address to /runs, keeping the run, the query and the hash', () => {
    expect(target(HISTORY)).toBe('/app/runs');
    expect(target(HISTORY, 'status=failed')).toBe('/app/runs?status=failed');
    expect(target(LIST)).toBe('/app/acme/atlas/runs');
    expect(target(LIST, 'tab=queue')).toBe('/app/acme/atlas/runs?tab=queue');
    expect(target(LAUNCH, 'case=flujo&revision=2')).toBe('/app/acme/atlas/runs/new?case=flujo&revision=2');
    expect(target(RUN)).toBe('/app/acme/atlas/runs/j1');
    expect(target(RUN, 'x=1')).toBe('/app/acme/atlas/runs/j1?x=1');
    expect(target(RUN, '', { org: 'a b', project: 'p/q', job: 'j#1' })).toBe('/app/a%20b/p%2Fq/runs/j%231');
    expect(followMoved('/app/acme/atlas/jobs/j1?x=1#top', routeDefinitions, movedRoutes)).toBe('/app/acme/atlas/runs/j1?x=1#top');
  });

  it('lets the static launcher address win over the run entry, each in one hop', () => {
    const table = [...config, ...movedRoutes.map((route) => ({ id: `moved:${route.id}`, path: route.path }))];
    const entryOf = (address: string) => matchRoutes(table, address)?.at(-1)?.route.id;
    expect(entryOf('/app/acme/atlas/jobs/new')).toBe('moved:job-launch-moved');
    expect(entryOf('/app/acme/atlas/jobs/j1')).toBe('moved:job-moved');
    expect(entryOf('/app/acme/atlas/jobs')).toBe('moved:job-list-moved');
    expect(entryOf('/app/jobs')).toBe('moved:job-history-moved');
    for (const [old, expected, screen] of [
      ['/app/jobs', '/app/runs', 'job-history'],
      ['/app/acme/atlas/jobs', '/app/acme/atlas/runs', 'job-list'],
      ['/app/acme/atlas/jobs/new?engine=x', '/app/acme/atlas/runs/new?engine=x', 'job-launch'],
      ['/app/acme/atlas/jobs/j1', '/app/acme/atlas/runs/j1', 'job-detail'],
    ]) {
      const settled = followMoved(old, routeDefinitions, movedRoutes);
      expect(settled).toBe(expected);
      expect(matchRoutes(config, settled.split('?')[0])?.at(-1)?.route.id).toBe(screen);
    }
  });

  it('does not collide with the study run addresses', () => {
    expect(movedRoutes.filter((route) => route.path.includes('/studies/')).map((route) => route.path)).toEqual([
      '/app/:org/:project/studies/:study/runs/:run',
      '/app/:org/:project/studies/:study/runs/:run/analytics',
      '/app/:org/:project/studies/:study/runs/:run/cells/:cell',
    ]);
    expect(followMoved('/app/acme/atlas/studies/s1/runs/r1', routeDefinitions, movedRoutes)).toBe('/app/acme/atlas/studies/s1/progress?run=r1');
  });
});
