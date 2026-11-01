import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../registry';

// The screens of this area exist in development builds only, so the list of the production screens that
// screenBudget.test.ts counts is empty: no `['id', '/path']` pair appears here.
const production = buildRegistry(false);
const development = buildRegistry(true);

describe('area system', () => {
  // [utest->req~frontend-nav-system-states-dev-only~1]
  it('declares no screen in the production registry', () => {
    expect(production.routesByArea.system).toEqual([]);
    expect(production.routeDefinitions.map((definition) => definition.id)).not.toContain('sys-states');
    expect(production.routeDefinitions.map((definition) => definition.path)).not.toContain('/app/system/states');
  });

  // [utest->req~frontend-nav-system-states-dev-only~1]
  it('declares sys-states at /app/system/states in the development registry, marked for development only', () => {
    // On one line: the pair-per-line scan of screenBudget.test.ts must not count it as a production screen.
    expect(development.routesByArea.system.map((definition) => [definition.id, definition.path])).toEqual([['sys-states', '/app/system/states']]);
    expect(development.routesByArea.system[0].devOnly).toBe(true);
    expect(development.routeDefinitions.map((definition) => definition.id)).toContain('sys-states');
  });

  // [utest->req~frontend-nav-system-states-dev-only~1]
  it('leaves every other screen to both registries', () => {
    const others = development.routeDefinitions.filter((definition) => !definition.devOnly);
    expect(production.routeDefinitions).toEqual(others);
  });

  describe('address resolution', () => {
    const resolve = (registry: typeof production, path: string) =>
      matchRoutes(registry.routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path })), path)?.at(-1)?.route.id ?? null;

    // [utest->req~frontend-nav-system-states-dev-only~1]
    it('resolves /app/system/states in development, and to no screen in production', () => {
      expect(resolve(development, '/app/system/states')).toBe('sys-states');
      expect(resolve(production, '/app/system/states')).not.toBe('sys-states');
    });
  });
});
