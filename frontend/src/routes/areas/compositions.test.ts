import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['composition-list', '/app/:org/compositions'],
  ['composition-detail', '/app/:org/compositions/:composition/:tab?'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id ?? null;

describe('area compositions', () => {
  it('has 2 screens: the list and the composition page with its tabs', () => {
    expect(routesByArea.compositions).toHaveLength(2);
    expect(routesByArea.compositions.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('comes after the organizations and before the problems in the registry', () => {
    const areas = Object.keys(routesByArea);
    expect(areas).toEqual(['public', 'auth', 'engines', 'account', 'organizations', 'compositions', 'problems', 'runs', 'studies', 'admin']);
  });

  it('serves both screens inside the workspace, signed in', () => {
    for (const definition of routesByArea.compositions) {
      expect(definition.layout, definition.id).toBe('app');
      expect(definition.requireAuth, definition.id).toBe(true);
      expect(definition.requireAdmin, definition.id).toBe(false);
    }
  });

  describe('address resolution', () => {
    it.each([
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
