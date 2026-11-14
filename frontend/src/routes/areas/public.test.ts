import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['pub-home', '/'],
  ['pub-workbench', '/workbench'],
  ['pub-about', '/about'],
  ['pub-pricing', '/pricing'],
];

describe('area public', () => {
  it('has 4 screens, with the ids and routes of the prototype', () => {
    expect(routesByArea.public).toHaveLength(4);
    expect(routesByArea.public.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('declares neither pub-explore nor the examples', () => {
    expect(routeDefinitions.map((definition) => definition.id)).not.toContain('pub-explore');
    expect(movedRoutes.map((entry) => entry.path)).not.toContain('/examples');
  });

  it('does not declare pub-status', () => {
    expect(routeDefinitions.map((definition) => definition.id)).not.toContain('pub-status');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/status');
  });

  it('serves every screen in the public layout, without a session', () => {
    for (const definition of routesByArea.public) {
      expect(definition.layout, definition.id).toBe('public');
      expect(definition.requireAuth, definition.id).toBe(false);
    }
  });

  describe('address resolution', () => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));

    it.each([
      ['/', 'pub-home'],
      ['/about', 'pub-about'],
      ['/explore', null],
      ['/explore/examples', null],
    ])('%s -> %s', (path, id) => {
      expect(matchRoutes(config, path)?.at(-1)?.route.id ?? null).toBe(id);
    });

    it('leaves /status to the moved-routes table', () => {
      expect(matchRoutes(config, '/status')).toBeNull();
    });
  });

  it('moves /status to /about and drops the query', () => {
    const route = movedRoutes.find((entry) => entry.path === '/status');
    expect(route?.id).toBe('status-retired');
    expect(route?.permanent).toBeFalsy();
    expect(route?.target(new URLSearchParams('probe=1'), {})).toBe('/about');
    expect(route?.target(new URLSearchParams(''), {})).toBe('/about');
  });
});
