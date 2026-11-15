import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const SCREENS: Array<[string, string]> = [
  ['proj-overview', '/app/:org/:project'],
  ['proj-settings', '/app/:org/:project/settings/:section?'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;
const idsOfScreens = routeDefinitions.map((definition) => definition.id);

describe('area project', () => {
  it('has 2 screens: the overview and the settings', () => {
    expect(routesByArea.project).toHaveLength(2);
    expect(routesByArea.project.map((definition) => [definition.id, definition.path])).toEqual(SCREENS);
  });

  it('declares neither proj-files nor proj-package', () => {
    expect(idsOfScreens).not.toContain('proj-files');
    expect(idsOfScreens).not.toContain('proj-package');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/:org/:project/files');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/:org/:project/package');
  });

  it('declares no published results screen', () => {
    expect(idsOfScreens).not.toContain('proj-publications');
    expect(resolve('/app/acme/atlas/published') ?? null).toBeNull();
  });

  it('declares no creation screen: a new project is made in a dialog over the organization', () => {
    expect(idsOfScreens).not.toContain('proj-create');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/:org/new-project');
  });

  describe('address resolution', () => {
    it.each([
      ['/app/acme/atlas', 'proj-overview'],
      ['/app/acme/atlas/settings', 'proj-settings'],
      ['/app/acme/atlas/settings/members', 'proj-settings'],
      ['/app/acme/atlas/settings/anything', 'proj-settings'],
      ['/app/acme/atlas/published', null],
      ['/app/acme/atlas/package', null],
      ['/app/acme/atlas/files', null],
      ['/app/acme/atlas/publications', null],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path) ?? null).toBe(id);
    });
  });
});
