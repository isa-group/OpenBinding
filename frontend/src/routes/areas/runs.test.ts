import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['job-launch', '/app/:org/:project/jobs/new'],
  ['job-list', '/app/:org/:project/jobs'],
  ['job-detail', '/app/:org/:project/jobs/:job'],
  ['job-history', '/app/jobs'],
  ['gen-lab', '/app/generator'],
];

describe('area runs', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 5 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.runs).toHaveLength(5);
    expect(routesByArea.runs.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('keeps the generator lab', () => {
    expect(routeDefinitions.map((definition) => definition.id)).toContain('gen-lab');
  });

  it('has the generator lab at the address of the prototype', () => {
    expect(routeDefinitions.find((definition) => definition.id === 'gen-lab')?.path).toBe('/app/generator');
  });

  it('keeps the job screens from being read as an organization or project', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    expect(matchRoutes(config, '/app/acme/atlas/jobs/new')?.at(-1)?.route.id).toBe('job-launch');
    expect(matchRoutes(config, '/app/jobs')?.at(-1)?.route.id).toBe('job-history');
  });
});
