import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['app-home', '/app'],
  ['org-overview', '/app/:org'],
  ['org-settings', '/app/:org/settings/:section?'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area organizations', () => {
  it('has 3 screens: the home, the organization and its settings', () => {
    expect(routesByArea.organizations).toHaveLength(3);
    expect(routesByArea.organizations.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('declares neither org-members nor org-audit: they are sections of org-settings', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('org-members');
    expect(ids).not.toContain('org-audit');
  });

  it('declares no creation screen: a new organization is made in a dialog', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('org-create');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/organizations/new');
  });

  it('keeps the fixed organization screens from being read as an organization or project', () => {
    expect(resolve('/app/acme/settings')).toBe('org-settings');
  });

  describe('address resolution', () => {
    it.each([
      ['/app', 'app-home'],
      ['/app/acme', 'org-overview'],
      ['/app/acme/settings', 'org-settings'],
      ['/app/acme/settings/members', 'org-settings'],
      ['/app/acme/settings/audit', 'org-settings'],
      ['/app/settings/settings', 'org-settings'],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path)).toBe(id);
    });
  });
});
