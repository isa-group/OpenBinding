import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['lang-profiles', '/language'],
  ['lang-schemas', '/language/schemas/:kind'],
  ['lang-examples', '/examples'],
  ['lang-extensions', '/app/language/extensions'],
];

describe('area language', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 4 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.language).toHaveLength(4);
    expect(routesByArea.language.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('reads the extensions address as its own screen', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    expect(matchRoutes(config, '/app/language/extensions')?.at(-1)?.route.id).toBe('lang-extensions');
  });
});
