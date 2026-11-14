import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { movedRoutes, routeDefinitions, routesByArea } from '../registry';

// One pair per line: screenBudget.test.ts counts them.
const PROTOTYPE: Array<[string, string]> = [
  ['lang-profiles', '/language/:section?/:item?'],
];

describe('area language', () => {
  it('has 1 screen: the hub', () => {
    expect(routesByArea.language).toHaveLength(1);
    expect(routesByArea.language.map((definition) => [definition.id, definition.path])).toEqual(PROTOTYPE);
  });

  it('removes lang-examples from the registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('lang-examples');
    expect(routeDefinitions.map((definition) => definition.path)).not.toContain('/examples');
  });

  it('moves /examples nowhere: the examples are gone', () => {
    expect(movedRoutes.map((entry) => entry.id)).not.toContain('lang-examples');
    expect(movedRoutes.map((entry) => entry.path)).not.toContain('/examples');
  });

  it('removes lang-schemas and lang-extensions from the registry', () => {
    const ids = routeDefinitions.map((definition) => definition.id);
    expect(ids).not.toContain('lang-schemas');
    expect(ids).not.toContain('lang-extensions');
  });

  it.each([
    '/language',
    '/language/schemas',
    '/language/schemas/Instance',
    '/language/schemas/application',
    '/language/extensions',
    '/language/unknown',
  ])('reads %s as the hub', (address) => {
    const config = routeDefinitions.map((definition) => ({ id: definition.id, path: definition.path }));
    expect(matchRoutes(config, address)?.at(-1)?.route.id).toBe('lang-profiles');
  });

  it('moves /app/language/extensions to /language/extensions and keeps the query', () => {
    const route = movedRoutes.find((entry) => entry.id === 'lang-extensions');
    expect(route?.path).toBe('/app/language/extensions');
    expect(route?.target(new URLSearchParams('tab=resources'), {})).toBe('/language/extensions?tab=resources');
    expect(route?.target(new URLSearchParams(''), {})).toBe('/language/extensions');
  });
});
