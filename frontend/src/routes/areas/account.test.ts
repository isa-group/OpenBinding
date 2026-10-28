import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['acct-profile', '/app/account'],
  ['acct-usage', '/app/account/usage'],
  ['acct-keys', '/app/account/keys'],
  ['acct-key-new', '/app/account/keys/new'],
  ['acct-identities', '/app/account/identities'],
  ['acct-notifications', '/app/account/notifications'],
];

describe('area account', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 6 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.account).toHaveLength(6);
    expect(routesByArea.account.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('keeps the fixed /app/account screens from being read as an organization or project', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    expect(matchRoutes(config, '/app/account/usage')?.at(-1)?.route.id).toBe('acct-usage');
    expect(matchRoutes(config, '/app/account/keys/new')?.at(-1)?.route.id).toBe('acct-key-new');
  });
});
