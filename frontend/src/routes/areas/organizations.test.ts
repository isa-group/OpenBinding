import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['app-home', '/app'],
  ['org-create', '/app/organizations/new'],
  ['org-overview', '/app/:org'],
  ['org-settings', '/app/:org/settings'],
  ['org-members', '/app/:org/settings/members'],
  ['org-audit', '/app/:org/settings/audit'],
];

describe('area organizations', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 6 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.organizations).toHaveLength(6);
    expect(routesByArea.organizations.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('keeps the fixed organization screens from being read as an organization or project', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;
    expect(resolve('/app/organizations/new')).toBe('org-create');
    expect(resolve('/app/acme/settings')).toBe('org-settings');
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    // [utest->req~frontend-nav-route-areas~1]
    it.each([
      ['/app', 'app-home'],
      ['/app/organizations/new', 'org-create'],
      ['/app/acme', 'org-overview'],
      ['/app/acme/settings', 'org-settings'],
      ['/app/acme/settings/members', 'org-members'],
      ['/app/acme/settings/audit', 'org-audit'],
      ['/app/settings/settings', 'org-settings'],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });
  });
});
