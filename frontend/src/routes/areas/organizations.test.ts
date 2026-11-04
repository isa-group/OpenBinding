import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';
import { moved as moves } from './organizations';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['app-home', '/app'],
  ['org-overview', '/app/:org'],
  ['org-settings', '/app/:org/settings/:section?'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area organizations', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 3 screens: the home, the organization and its settings', () => {
    expect(routesByArea.organizations).toHaveLength(3);
    expect(routesByArea.organizations.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-nav-org-settings-sections~1]
  it('declares neither org-members nor org-audit: they are sections of org-settings', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('org-members');
    expect(ids).not.toContain('org-audit');
  });

  // [utest->req~frontend-nav-create-dialogs~1]
  it('declares no creation screen: a new organization is made in a dialog', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('org-create');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/organizations/new');
  });

  it('keeps the fixed organization screens from being read as an organization or project', () => {
    expect(resolve('/app/acme/settings')).toBe('org-settings');
  });

  describe('address resolution', () => {
    // [utest->req~frontend-nav-route-areas~1]
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

  describe('the moved addresses of the area', () => {
    // [utest->req~frontend-nav-create-dialogs~1]
    it('moves the old creation address to the dialog over the home, and drops its query', () => {
      expect(moves.map((route) => route.path)).toEqual(['/app/organizations/new']);
      const [route] = moves;
      expect(route.target(new URLSearchParams(''), {})).toBe('/app?create=organization');
      expect(route.target(new URLSearchParams('a=1'), {})).toBe('/app?create=organization');
      expect(route.permanent).toBeUndefined();
      expect(resolve('/app')).toBe('app-home');
    });

    // [utest->req~frontend-nav-redirects~1]
    it('gives the entry an id that no screen and no other entry uses', () => {
      const ids = [...routeDefinitions.map((definition) => definition.id), ...movedRoutes.map((route) => route.id)];
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
