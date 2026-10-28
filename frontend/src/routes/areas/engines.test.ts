import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['eng-catalog', '/engines'],
  ['eng-detail', '/engines/:namespace/:name/:version'],
  ['eng-register', '/app/engines/new'],
  ['eng-registrations', '/app/engines/registrations'],
  ['eng-registration-detail', '/app/engines/registrations/:name'],
];

const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
const resolve = (path: string) => matchRoutes(config, path)?.at(-1)?.route.id;

describe('area engines', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 5 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.engines).toHaveLength(5);
    expect(routesByArea.engines.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('reads the registration detail below the registrations list and /engines/new as no screen', () => {
    expect(resolve('/app/engines/registrations')).toBe('eng-registrations');
    expect(resolve('/app/engines/registrations/edge-solver')).toBe('eng-registration-detail');
    expect(matchRoutes(config, '/engines/new')).toBeNull();
  });

  it('keeps the fixed /app/engines screen from being read as an organization or project', () => {
    expect(resolve('/app/engines/new')).toBe('eng-register');
  });

  describe('address resolution', () => {
    // [utest->req~frontend-nav-route-areas~1]
    it.each([
      ['/engines/bim.builtin/random-search/1.0.0', 'eng-detail'],
      ['/engines/new', null],
      ['/app/engines/new', 'eng-register'],
      ['/app/engines/registrations', 'eng-registrations'],
      ['/app/engines/registrations/edge', 'eng-registration-detail'],
      ['/app/engines/registrations/settings', 'eng-registration-detail'],
    ])('%s -> %s', (path, id) => {
      expect(resolve(path) ?? null).toBe(id);
    });
  });
});
