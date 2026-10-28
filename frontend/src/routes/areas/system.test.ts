import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['sys-states', '/app/system/states'],
];

describe('area system', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 1 screen, with the id and route of the prototype', () => {
    expect(routesByArea.system).toHaveLength(1);
    expect(routesByArea.system.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    // [utest->req~frontend-nav-route-areas~1]
    it.each([
      ['/app/system/states', 'sys-states'],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });
  });
});
