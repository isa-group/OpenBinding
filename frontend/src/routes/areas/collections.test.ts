import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['coll-list', '/app/:org/:project/collections'],
  ['coll-detail', '/app/:org/:project/collections/:collection'],
];

describe('area collections', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 2 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.collections).toHaveLength(2);
    expect(routesByArea.collections.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-retire-library-screens-not-routed~1]
  it('keeps the collections', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const id of ['coll-list', 'coll-detail']) expect(ids, id).toContain(id);
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    // [utest->req~frontend-nav-route-areas~1]
    it.each([
      ['/app/acme/atlas/collections', 'coll-list'],
      ['/app/acme/atlas/collections/k1', 'coll-detail'],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });
  });
});
