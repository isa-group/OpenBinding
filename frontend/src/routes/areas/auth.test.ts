import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['auth-login', '/login'],
  ['auth-register', '/register'],
  ['auth-reset-request', '/password-reset'],
  ['auth-reset-complete', '/password-reset/complete'],
  ['auth-cas-callback', '/auth/cas/callback'],
  ['org-invite-accept', '/invitations/accept'],
];

describe('area auth', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 6 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.auth).toHaveLength(6);
    expect(routesByArea.auth.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('serves every screen in the public layout, and only the invitation link switches header with the session', () => {
    for (const definition of routesByArea.auth) {
      expect(definition.layout, definition.id).toBe('public');
      expect(definition.sessionHeader, definition.id).toBe(definition.id === 'org-invite-accept');
    }
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    // [utest->req~frontend-nav-route-areas~1]
    it.each([
      ['/password-reset/complete', 'auth-reset-complete'],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });
  });
});
