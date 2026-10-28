import { describe, expect, it } from 'vitest';
import { routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['pub-home', '/'],
  ['pub-explore', '/explore'],
  ['pub-workbench', '/workbench'],
  ['pub-about', '/about'],
  ['pub-status', '/status'],
  ['pub-pricing', '/pricing'],
];

describe('area public', () => {
  // [utest->req~frontend-nav-route-areas~1]
  it('has 6 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.public).toHaveLength(6);
    expect(routesByArea.public.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('serves every screen in the public layout, without a session', () => {
    for (const definition of routesByArea.public) {
      expect(definition.layout, definition.id).toBe('public');
      expect(definition.requireAuth, definition.id).toBe(false);
    }
  });
});
