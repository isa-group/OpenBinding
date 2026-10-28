import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['pub-resolve', '/resolve/:kind/:digest'],
  ['verifier', '/app/verifier'],
];

describe('area verify', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 2 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.verify).toHaveLength(2);
    expect(routesByArea.verify.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  // [utest->req~frontend-retire-reports-screen-count~1]
  it('keeps the verifier, which holds nothing about reports', () => {
    expect(routeDefinitions.map((definition) => definition.id)).toContain('verifier');
  });

  // [utest->req~frontend-retire-reports-publications-stay~1]
  it('still resolves the verifier address through the route definitions', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    expect(matchRoutes(config, '/app/verifier')?.at(-1)?.route.id).toBe('verifier');
  });
});
