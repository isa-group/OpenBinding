import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';
import { routes } from './account';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['acct-profile', '/app/account/:section?'],
];

describe('area account', () => {
  it('has 1 screen, acct-profile, with the section segment optional', () => {
    expect(routesByArea.account).toHaveLength(1);
    expect(routesByArea.account.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('declares none of the former account screens: they are sections of acct-profile', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    for (const former of ['acct-usage', 'acct-keys', 'acct-key-new', 'acct-identities', 'acct-notifications']) {
      expect(ids, former).not.toContain(former);
      expect(routes.map((definition) => definition.id), former).not.toContain(former);
    }
  });

  it('keeps the fixed /app/account screens from being read as an organization or project', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    expect(matchRoutes(config, '/app/account/usage')?.at(-1)?.route.id).toBe('acct-profile');
    expect(matchRoutes(config, '/app/account/keys')?.at(-1)?.route.id).toBe('acct-profile');
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    it.each([
      ['/app/account', 'acct-profile'],
      ['/app/account/usage', 'acct-profile'],
      ['/app/account/keys', 'acct-profile'],
      ['/app/account/identities', 'acct-profile'],
      ['/app/account/notifications', 'acct-profile'],
      ['/app/account/billing', 'acct-profile'],
      ['/app/account/keys/other', null],
      ['/app/account/keys/new', null],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });
  });

  describe('the moved address of the new API key', () => {
    const entry = movedRoutes.find((route) => route.path === '/app/account/keys/new');

    it('leads to the API keys section with the creation dialog open, and drops the query', () => {
      expect(entry?.id).toBe('acct-key-new');
      expect(entry?.permanent).toBeFalsy();
      expect(entry?.target(new URLSearchParams(), {})).toBe('/app/account/keys?create=key');
      expect(entry?.target(new URLSearchParams('x=1'), {})).toBe('/app/account/keys?create=key');
    });

    it('is a moved entry, not a screen', () => {
      expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/app/account/keys/new');
    });
  });
});
