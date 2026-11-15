import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['auth-login', '/login'],
  ['auth-register', '/register'],
  ['auth-reset-request', '/password-reset'],
  ['auth-cas-callback', '/auth/cas/callback'],
  ['org-invite-accept', '/invitations/accept'],
];

describe('area auth', () => {
  it('has 5 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.auth).toHaveLength(5);
    expect(routesByArea.auth.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('does not route the second password-reset screen', () => {
    expect(routeDefinitions.map((definition) => definition.id)).not.toContain('auth-reset-complete');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/password-reset/complete');
  });

  it('serves every screen in the public layout, and only the invitation link switches header with the session', () => {
    for (const definition of routesByArea.auth) {
      expect(definition.layout, definition.id).toBe('public');
      expect(definition.sessionHeader, definition.id).toBe(definition.id === 'org-invite-accept');
    }
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    it.each([
      ['/password-reset', 'auth-reset-request'],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });

    it('answers /password-reset/complete with no screen', () => {
      expect(matchRoutes(config, '/password-reset/complete')).toBeNull();
    });
  });
});
