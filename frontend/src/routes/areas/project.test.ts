import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['proj-create', '/app/:org/new-project'],
  ['proj-overview', '/app/:org/:project'],
  ['proj-settings', '/app/:org/:project/settings'],
  ['proj-package', '/app/:org/:project/package'],
  ['proj-files', '/app/:org/:project/files'],
  ['proj-publications', '/app/:org/:project/publications'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

describe('area project', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 6 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.project).toHaveLength(6);
    expect(routesByArea.project.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('keeps the files', () => {
    expect(routeDefinitions.map((definition) => definition.id)).toContain('proj-files');
  });

  // [utest->req~frontend-retire-reports-screen-count~1]
  it('keeps the publications, which hold nothing about reports', () => {
    expect(routeDefinitions.map((definition) => definition.id)).toContain('proj-publications');
  });

  // [utest->req~frontend-retire-reports-publications-stay~1]
  it('still resolves the publications address through the route definitions', () => {
    expect(resolve('/app/acme/atlas/publications')).toBe('proj-publications');
  });

  it('keeps the fixed project screen from being read as an organization or project', () => {
    expect(resolve('/app/acme/new-project')).toBe('proj-create');
  });
});
