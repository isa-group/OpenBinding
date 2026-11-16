import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['pub-compositions', '/compositions'],
  ['pub-showcase', '/c/:org/:composition'],
  ['composition-list', '/app/:org/compositions'],
  ['composition-detail', '/app/:org/compositions/:composition/:tab?'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area compositions', () => {
  it('has 4 screens: the public list, the public page, the list of an organization and the composition page with its tabs', () => {
    expect(routesByArea.compositions).toHaveLength(4);
    expect(routesByArea.compositions.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('comes after the organizations and before the problems in the registry', () => {
    const areas = Object.keys(routesByArea);
    expect(areas).toEqual(['public', 'auth', 'engines', 'account', 'organizations', 'compositions', 'problems', 'runs', 'studies', 'admin']);
  });

  it('serves the organization screens inside the workspace, signed in', () => {
    for (const definition of routesByArea.compositions.filter((item) => item.path.startsWith('/app/'))) {
      expect(definition.layout, definition.id).toBe('app');
      expect(definition.requireAuth, definition.id).toBe(true);
      expect(definition.requireAdmin, definition.id).toBe(false);
      expect(definition.sessionHeader, definition.id).toBe(false);
    }
  });

  it('serves the public list and the public page to anybody, with the application header for a signed-in person', () => {
    const open = routesByArea.compositions.filter((item) => !item.path.startsWith('/app/'));
    expect(open.map((definition) => definition.id)).toEqual(['pub-compositions', 'pub-showcase']);
    for (const definition of open) {
      expect(definition.layout, definition.id).toBe('public');
      expect(definition.requireAuth, definition.id).toBe(false);
      expect(definition.requireAdmin, definition.id).toBe(false);
      expect(definition.sessionHeader, definition.id).toBe(true);
    }
  });

  describe('address resolution', () => {
    it.each([
      ['/compositions', 'pub-compositions'],
      ['/c/acme/order-desk', 'pub-showcase'],
      ['/c/acme', null],
      ['/c/acme/order-desk/versions', null],
      ['/app/acme/compositions', 'composition-list'],
      ['/app/acme/compositions/order-desk', 'composition-detail'],
      ['/app/acme/compositions/order-desk/editor', 'composition-detail'],
      ['/app/acme/compositions/order-desk/versions/2', null],
      ['/app/acme/problems', 'case-list'],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path)).toBe(id);
    });
  });
});
