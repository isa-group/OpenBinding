import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';
import { RUNS_SEGMENT } from '../paths/runs';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['job-launch', '/app/:org/:project/runs/new'],
  ['job-list', '/app/:org/:project/runs'],
  ['job-detail', '/app/:org/:project/runs/:job'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

describe('area runs', () => {
  it('has 3 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.runs).toHaveLength(3);
    expect(routesByArea.runs.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('routes no path with a jobs segment, and names the segment once', () => {
    expect(routeDefinitions.map((definition) => definition.path).filter((path) => path.split('/').includes('jobs'))).toEqual([]);
    expect(RUNS_SEGMENT).toBe('runs');
  });

  it('has no run history: the account-wide runs address is no screen of the area', () => {
    expect(routeDefinitions.map((definition) => definition.id)).not.toContain('job-history');
    expect(matchRoutes(config, '/app/acme/atlas/runs/new')?.at(-1)?.route.id).toBe('job-launch');
    expect(matchRoutes(config, '/app/runs')?.at(-1)?.route.id).toBe('org-overview');
  });

  describe('address resolution', () => {
    it.each([
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
